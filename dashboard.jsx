/**
 * Kiva Youth Fund Filter Dashboard
 *
 * Key schema facts:
 *  - Search:        lend { loans(offset, limit, filters: LoanSearchFiltersInput, sortBy) }
 *  - Portfolio:     my { loans(offset, limit): LoanBasicCollection }
 *  - Country:       loan.geocode.country.isoCode   (not a top-level string)
 *  - Partner stats: loan.partner.{ id name riskRating defaultRate }
 *  - Borrower ID:   loan.borrowers[0].id
 *  - Age:           ... on LoanDirect { ageAtTimeOfLoan }  (requires auth)
 *  - Sector filter: sector: [Int]  (inclusion by ID only, exclusion is client-side)
 *  - Range filters: MinMaxRangeInput { min, max }
 *  - Term field:    lenderRepaymentTerm  (on loan object; lenderTerm in filter input)
 */

import { useState, useEffect, useCallback } from "react";

// config
const GRAPHQL_URL = "https://gateway.production.kiva.org/graphql";
const KIVA_USER = typeof import.meta !== "undefined" ? import.meta.env?.VITE_KIVA_USER : null;
const KIVA_PASS = typeof import.meta !== "undefined" ? import.meta.env?.VITE_KIVA_PASS : null;

// graphql client
async function gql(query, variables = {}, token = null) {
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
    Origin: "https://www.kiva.org",
    Referer: "https://www.kiva.org/lend",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(body.errors.map(e => e.message).join("; "));
  return body.data;
}

// auth
async function kivaLogin(email, password) {
  const data = await gql(`
    mutation Login($email: String!, $password: String!) {
      login(email: $email, password: $password) {
        token
        user { id }
      }
    }
  `, { email, password });
  return data.login.token;
}

// shared loan fragment
const LOAN_FIELDS = `
  __typename
  id
  name
  description
  descriptionInOriginalLanguage
  lenderRepaymentTerm
  geocode {
    country {
      isoCode
      name
    }
  }
  borrowers {
    id
    firstName
    gender
  }
  sector { id name }
  partner {
    id
    name
    riskRating
    defaultRate
  }
  loanAmount { amount }
  tags
  ... on LoanDirect {
    ageAtTimeOfLoan
  }
`;

// Fetch my protfolio:  my { loans(...): LoanBasicCollection }
async function fetchMyPortfolio(token, pageSize = 40) {
  const all = [];
  let offset = 0;
  while (true) {
    const data = await gql(`
      query MyLoans($offset: Int!, $limit: Int!) {
        my {
          loans(offset: $offset, limit: $limit) {
            totalCount
            values { ${LOAN_FIELDS} }
          }
        }
      }
    `, { offset, limit: pageSize }, token);
    const { totalCount, values } = data.my.loans;
    all.push(...values);
    if (all.length >= totalCount || values.length === 0) break;
    offset += pageSize;
    await sleep(600);
  }
  return all;
}

// Fetch candidate loans: lend { loans(...): LoanBasicCollection }
async function fetchCandidateLoans(token, gqlFilters, pageSize = 40, maxPages = 25) {
  const all = [];
  let offset = 0;
  for (let p = 0; p < maxPages; p++) {
    const data = await gql(`
      query CandidateLoans($offset: Int!, $limit: Int!, $filters: LoanSearchFiltersInput) {
        lend {
          loans(offset: $offset, limit: $limit, filters: $filters, sortBy: newest) {
            totalCount
            values { ${LOAN_FIELDS} }
          }
        }
      }
    `, { offset, limit: pageSize, filters: gqlFilters }, token);
    const { totalCount, values } = data.lend.loans;
    all.push(...values);
    if (all.length >= totalCount || values.length === 0) break;
    offset += pageSize;
    await sleep(800);
  }
  return all;
}

// loan mapper
function mapLoan(raw) {
  return {
    id: raw.id,
    name: raw.name,
    age: raw.ageAtTimeOfLoan ?? null,
    country: raw.geocode?.country?.isoCode ?? "??",
    countryName: raw.geocode?.country?.name ?? "",
    partnerId: raw.partner?.id ?? null,
    partner: raw.partner?.name ?? "Direct",
    risk: raw.partner?.riskRating ?? null,
    defRate: raw.partner?.defaultRate ?? null,
    term: raw.lenderRepaymentTerm ?? null,
    amount: raw.loanAmount?.amount ?? 0,
    sector: raw.sector?.name ?? "",
    sectorId: raw.sector?.id ?? null,
    description: raw.description ?? "",
    descriptionOrig: raw.descriptionInOriginalLanguage ?? "",
    borrowerId: raw.borrowers?.[0]?.id ?? `anon-${raw.id}`,
    tags: raw.tags ?? [],
    priorCount: 0, tier: 1, lendAmount: 25,
    countryPct: 0, partnerPct: 0,
    phraseHit: false, pass: false, reasons: [],
  };
}

// client-side filter
function applyClientFilters(candidates, portfolio, cfg) {
  const phrase = cfg.phrase.trim().toLowerCase();
  const portTotal = portfolio.length;

  return candidates.map(loan => {
    const reasons = [];

    // repeat-borrower tier (from existing portfolio)
    const prior = portfolio.filter(p => p.borrowerId === loan.borrowerId).length;
    const tier = prior === 0 ? 1 : prior === 1 ? 2 : prior === 2 ? 3 : 4;
    const lendAmount = tier <= 2 ? 25 : tier === 3 ? 50 : 100;

    // concentration: portfolio + this candidate combined
    const countryInPort = portfolio.filter(p => p.country === loan.country).length;
    const partnerInPort = portfolio.filter(p => p.partnerId === loan.partnerId).length;
    const countryPct = portTotal > 0 ? ((countryInPort + 1) / (portTotal + 1)) * 100 : 0;
    const partnerPct = portTotal > 0 && loan.partnerId
      ? ((partnerInPort + 1) / (portTotal + 1)) * 100 : 0;

    // Batch
    const risk = loan.risk, def = loan.defRate;
    const inA = risk !== null && def !== null && risk >= 2 && def <= 0.01;
    const inB = risk !== null && def !== null && risk >= 2 && def > 0.01 && def <= 0.02;
    if (cfg.batch === "A"    && !inA)        reasons.push(`Batch A: need risk≥2 & default≤1% (risk=${risk?.toFixed(1) ?? "?"}, def=${def !== null ? (def * 100).toFixed(2) + "%" : "?"})`);
    if (cfg.batch === "B"    && !inB)        reasons.push(`Batch B: need risk≥2 & default 1.1–2%`);
    if (cfg.batch === "BOTH" && !inA && !inB) reasons.push(`Not in Batch A or B (def=${def !== null ? (def * 100).toFixed(2) + "%" : "?"})`);

    // age: only on LoanDirect, only when authenticated
    if (cfg.ageFilter) {
      if (loan.age === null) reasons.push("Age unknown (field-partner loan or not authenticated as direct lender)");
      else if (loan.age < cfg.minAge || loan.age > cfg.maxAge)
        reasons.push(`Age ${loan.age} outside ${cfg.minAge}–${cfg.maxAge}`);
    }

    // Phrase
    const phraseHit = phrase === "" ||
      loan.description.toLowerCase().includes(phrase) ||
      loan.descriptionOrig.toLowerCase().includes(phrase);
    if (phrase !== "" && !phraseHit) reasons.push(`Phrase "${cfg.phrase}" not in description`);

    // Term
    if (loan.term !== null && loan.term > cfg.maxTerm)
      reasons.push(`lenderRepaymentTerm ${loan.term}mo > max ${cfg.maxTerm}mo`);

    // Caps
    if (countryPct >= cfg.countryCap)
      reasons.push(`Country ${loan.country} at ${countryPct.toFixed(1)}% ≥ cap ${cfg.countryCap}%`);
    if (loan.partnerId && partnerPct >= cfg.partnerCap)
      reasons.push(`Partner "${loan.partner}" at ${partnerPct.toFixed(1)}% ≥ cap ${cfg.partnerCap}%`);

    // sector exclusion (client-side, schema sector filter only does inclusion by [Int] ID)
    if (cfg.excludedSectors.includes(loan.sector))
      reasons.push(`Excluded sector: ${loan.sector}`);

    return {
      ...loan, priorCount: prior, tier, lendAmount,
      countryPct: countryPct / 100, partnerPct: partnerPct / 100,
      phraseHit, pass: reasons.length === 0, reasons,
    };
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// UI compoentns
function StatCard({ label, value, accent }) {
  return (
    <div style={{ background: "#0f1117", border: `1px solid ${accent || "#2a2d3a"}`, borderRadius: 8, padding: "18px 22px", minWidth: 130 }}>
      <div style={{ color: "#555", fontSize: 11, letterSpacing: 2, textTransform: "uppercase", marginBottom: 6 }}>{label}</div>
      <div style={{ color: accent || "#e8d5a3", fontSize: 28, fontFamily: "'DM Mono',monospace", fontWeight: 600, lineHeight: 1 }}>{value}</div>
    </div>
  );
}

function Badge({ text, color }) {
  const map = { green: ["#1a3d2e","#4ade80"], red: ["#3d1a1a","#f87171"], amber: ["#3d2e0a","#fbbf24"], blue: ["#0a1f3d","#60a5fa"], gray: ["#1e2030","#888"] };
  const [bg, fg] = map[color] || map.gray;
  return <span style={{ background: bg, color: fg, padding: "2px 8px", borderRadius: 4, fontSize: 11, fontFamily: "'DM Mono',monospace", letterSpacing: 0.5, whiteSpace: "nowrap" }}>{text}</span>;
}

function RiskBar({ value }) {
  if (value === null) return <span style={{ color: "#333", fontSize: 11 }}>—</span>;
  const col = value <= 2 ? "#4ade80" : value <= 3.5 ? "#fbbf24" : "#f87171";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ width: 60, height: 6, background: "#1e2030", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${(value / 5) * 100}%`, height: "100%", background: col, borderRadius: 3 }} />
      </div>
      <span style={{ color: col, fontSize: 12, fontFamily: "'DM Mono',monospace" }}>{value.toFixed(1)}</span>
    </div>
  );
}

function LoanRow({ loan, index, onExpand, expanded }) {
  const tierColor = { 1: "gray", 2: "gray", 3: "blue", 4: "amber" };
  return (
    <>
      <tr onClick={() => onExpand(loan.id)} style={{
        background: expanded ? "#0d1520" : index % 2 === 0 ? "#0a0c12" : "#0c0e16",
        cursor: "pointer",
        borderLeft: `3px solid ${loan.pass ? "#2d6a4f" : "#5c1a1a"}`,
      }}>
        <td style={{ padding: "10px 14px", color: "#555", fontSize: 11, fontFamily: "'DM Mono',monospace" }}>{loan.id}</td>
        <td style={{ padding: "10px 14px" }}>
          <div style={{ color: "#e8d5a3", fontSize: 13, fontWeight: 500 }}>{loan.name}</div>
          <div style={{ color: "#444", fontSize: 11 }}>{loan.sector}</div>
        </td>
        <td style={{ padding: "10px 14px", textAlign: "center", color: "#93c5fd", fontFamily: "'DM Mono',monospace", fontSize: 13 }}>
          {loan.age !== null ? `${loan.age}y` : <span style={{ color: "#333" }}>—</span>}
        </td>
        <td style={{ padding: "10px 14px" }}><Badge text={loan.country} color="blue" /></td>
        <td style={{ padding: "10px 14px" }}><RiskBar value={loan.risk} /></td>
        <td style={{ padding: "10px 14px", fontFamily: "'DM Mono',monospace", fontSize: 12 }}>
          {loan.defRate !== null
            ? <span style={{ color: loan.defRate <= 0.01 ? "#4ade80" : loan.defRate <= 0.02 ? "#fbbf24" : "#f87171" }}>
                {(loan.defRate * 100).toFixed(2)}%
              </span>
            : <span style={{ color: "#333" }}>—</span>}
        </td>
        <td style={{ padding: "10px 14px", fontFamily: "'DM Mono',monospace", fontSize: 12, color: "#888" }}>
          {loan.term !== null ? `${loan.term}mo` : "—"}
        </td>
        <td style={{ padding: "10px 14px", textAlign: "center" }}><Badge text={`Tier ${loan.tier}`} color={tierColor[loan.tier]} /></td>
        <td style={{ padding: "10px 14px", textAlign: "center" }}>
          <span style={{ color: "#4ade80", fontFamily: "'DM Mono',monospace", fontSize: 13, fontWeight: 600 }}>${loan.lendAmount}</span>
        </td>
        <td style={{ padding: "10px 14px", textAlign: "center" }}>
          {loan.pass ? <Badge text="PASS" color="green" /> : <Badge text="FAIL" color="red" />}
        </td>
      </tr>
      {expanded && (
        <tr style={{ background: "#0d1520" }}>
          <td colSpan={10} style={{ padding: "0 14px 14px 14px" }}>
            <div style={{ borderTop: "1px solid #1e2030", paddingTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <div>
                <div style={{ color: "#555", fontSize: 11, letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 6 }}>Description</div>
                <p style={{ color: "#aaa", fontSize: 13, lineHeight: 1.6, margin: 0 }}>{loan.description}</p>
                <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <Badge text={`Partner: ${loan.partner}`} color="gray" />
                  <Badge text={`Prior: ${loan.priorCount} loans`} color="gray" />
                  <Badge text={`Country: ${(loan.countryPct * 100).toFixed(1)}%`} color={loan.countryPct >= 0.10 ? "red" : "gray"} />
                  <Badge text={`Partner: ${(loan.partnerPct * 100).toFixed(1)}%`} color={loan.partnerPct >= 0.10 ? "red" : "gray"} />
                  {loan.phraseHit && <Badge text="✓ Phrase match" color="green" />}
                  {loan.tags?.slice(0, 4).map(t => <Badge key={t} text={t} color="gray" />)}
                </div>
              </div>
              {!loan.pass && (
                <div>
                  <div style={{ color: "#f87171", fontSize: 11, letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 6 }}>Rejection reasons</div>
                  <ul style={{ margin: 0, paddingLeft: 16 }}>
                    {loan.reasons.map((r, i) => <li key={i} style={{ color: "#f87171", fontSize: 12, marginBottom: 4 }}>{r}</li>)}
                  </ul>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// main app
export default function App() {
  const [token, setToken]             = useState(null);
  const [authError, setAuthError]     = useState(null);
  const [loggingIn, setLoggingIn]     = useState(false);
  const [email, setEmail]             = useState(KIVA_USER || "");
  const [password, setPassword]       = useState(KIVA_PASS || "");
  const [portfolio, setPortfolio]     = useState([]);
  const [filtered, setFiltered]       = useState([]);
  const [bootstrapStatus, setBootstrapStatus] = useState("idle");
  const [running, setRunning]         = useState(false);
  const [hasRun, setHasRun]           = useState(false);
  const [expanded, setExpanded]       = useState(null);
  const [search, setSearch]           = useState("");
  const [activeTab, setActiveTab]     = useState("results");
  const [statusMsg, setStatusMsg]     = useState("");

  const [cfg, setCfg] = useState({
    batch: "BOTH",
    ageFilter: true, minAge: 18, maxAge: 26,
    phrase: "18 years old",
    maxTerm: 12,
    countryCap: 10, partnerCap: 10,
    excludedSectors: [],
    showFailing: false,
  });

  async function bootstrap(tok) {
    setBootstrapStatus("loading");
    setStatusMsg("Fetching your portfolio via my { loans }…");
    try {
      const raw = await fetchMyPortfolio(tok);
      setPortfolio(raw.map(mapLoan));
      setBootstrapStatus("ready");
      setStatusMsg(`Portfolio loaded — ${raw.length} loans`);
    } catch (e) {
      setBootstrapStatus("error");
      setStatusMsg(`Portfolio error: ${e.message}`);
    }
  }

  async function handleLogin() {
    if (!email || !password) return;
    setLoggingIn(true);
    setAuthError(null);
    try {
      const tok = await kivaLogin(email, password);
      setToken(tok);
      await bootstrap(tok);
    } catch (e) {
      setAuthError(e.message);
    } finally {
      setLoggingIn(false);
    }
  }

  useEffect(() => { if (KIVA_USER && KIVA_PASS) handleLogin(); }, []);

  const runFilter = useCallback(async () => {
    if (!token || bootstrapStatus !== "ready") return;
    setRunning(true);
    setHasRun(false);
    setFiltered([]);

    try {
      // Build server-side filters
      // riskRating / defaultRate / lenderTerm all use MinMaxRangeInput { min, max }
      const gqlFilters = {
        status: "fundraising",
        distributionModel: "both",
        lenderTerm: { max: cfg.maxTerm },
      };
      if (cfg.batch === "A") {
        gqlFilters.riskRating  = { min: 2 };
        gqlFilters.defaultRate = { max: 0.01 };
      } else if (cfg.batch === "B") {
        gqlFilters.riskRating  = { min: 2 };
        gqlFilters.defaultRate = { min: 0.011, max: 0.02 };
      } else {
        // both: fetch superset, split client-side
        gqlFilters.riskRating  = { min: 2 };
        gqlFilters.defaultRate = { max: 0.02 };
      }
      // sector exclusion is client-side only; schema uses sector: [Int] for inclusion

      setStatusMsg("Fetching candidates from lend { loans }…");
      const rawCandidates = await fetchCandidateLoans(token, gqlFilters);
      const mapped = rawCandidates.map(mapLoan);

      setStatusMsg("Applying client-side filters…");
      const results = applyClientFilters(mapped, portfolio, cfg);
      setFiltered(results);
      setHasRun(true);
      setStatusMsg(`Done — ${results.filter(l => l.pass).length} passing of ${results.length}`);
    } catch (e) {
      setStatusMsg(`Error during filter run: ${e.message}`);
    } finally {
      setRunning(false);
    }
  }, [token, portfolio, cfg, bootstrapStatus]);

  const passing     = filtered.filter(l => l.pass);
  const failing     = filtered.filter(l => !l.pass);
  const shown       = (cfg.showFailing ? filtered : passing).filter(l =>
    search === "" ||
    l.name.toLowerCase().includes(search.toLowerCase()) ||
    l.country.toLowerCase().includes(search.toLowerCase()) ||
    String(l.id).includes(search)
  );
  const totalLend   = passing.reduce((s, l) => s + l.lendAmount, 0);
  const batchACount = passing.filter(l => l.risk >= 2 && l.defRate <= 0.01).length;
  const batchBCount = passing.filter(l => l.risk >= 2 && l.defRate > 0.01 && l.defRate <= 0.02).length;

  const sectorOptions = ["Agriculture","Food","Retail","Services","Education","Health","Housing","Arts","Clothing","Transport"];

  // login screen
  if (!token) {
    return (
      <div style={{ minHeight: "100vh", background: "#080a0f", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'DM Sans', sans-serif" }}>
        <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&family=Playfair+Display:wght@700&display=swap'); *{box-sizing:border-box;}`}</style>
        <div style={{ background: "#0a0c12", border: "1px solid #1a1d2a", borderRadius: 12, padding: "40px 48px", width: 420 }}>
          <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, color: "#e8d5a3", marginBottom: 4 }}>Kiva</div>
          <div style={{ color: "#444", fontSize: 12, letterSpacing: 2, textTransform: "uppercase", marginBottom: 32 }}>Youth Fund Filter</div>
          {authError && <div style={{ background: "#3d1a1a", border: "1px solid #5c1a1a", borderRadius: 6, padding: "10px 14px", color: "#f87171", fontSize: 13, marginBottom: 20 }}>{authError}</div>}
          {[["Email", email, setEmail, "email"], ["Password", password, setPassword, "password"]].map(([label, val, setter, type]) => (
            <div key={label} style={{ marginBottom: 16 }}>
              <div style={{ color: "#555", fontSize: 11, letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 6 }}>{label}</div>
              <input type={type} value={val} onChange={e => setter(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleLogin()}
                style={{ width: "100%", background: "#0f1117", border: "1px solid #2a2d3a", borderRadius: 6, color: "#e8d5a3", padding: "10px 14px", fontSize: 14 }} />
            </div>
          ))}
          <button onClick={handleLogin} disabled={loggingIn} style={{
            width: "100%", background: loggingIn ? "#6b4e10" : "#c8991f", color: "#0a0c12",
            border: "none", borderRadius: 8, padding: "13px 0", fontSize: 14, fontWeight: 700,
            letterSpacing: 1.5, textTransform: "uppercase", cursor: loggingIn ? "not-allowed" : "pointer",
          }}>
            {loggingIn ? "Signing in…" : "Sign In"}
          </button>
          <div style={{ color: "#333", fontSize: 11, marginTop: 20, lineHeight: 1.6 }}>
            Credentials used only to obtain a Kiva JWT. Set <code style={{ color: "#555" }}>VITE_KIVA_USER</code> + <code style={{ color: "#555" }}>VITE_KIVA_PASS</code> to skip this screen.
          </div>
        </div>
      </div>
    );
  }

  // dashboard
  return (
    <div style={{ minHeight: "100vh", background: "#080a0f", fontFamily: "'DM Sans', sans-serif", color: "#c8cad4" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&family=Playfair+Display:wght@700&display=swap');
        *{box-sizing:border-box;}
        ::-webkit-scrollbar{width:6px;height:6px;}
        ::-webkit-scrollbar-track{background:#0a0c12;}
        ::-webkit-scrollbar-thumb{background:#2a2d3a;border-radius:3px;}
        input,select,button{font-family:inherit;}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
        .fade-in{animation:fadeIn 0.35s ease forwards;}
        tr:hover td{background:rgba(232,213,163,0.02)!important;}
      `}</style>

      {/* Header */}
      <div style={{ borderBottom: "1px solid #1a1d2a", background: "rgba(8,10,15,0.96)", backdropFilter: "blur(10px)", position: "sticky", top: 0, zIndex: 100, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 32px", height: 64 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, color: "#e8d5a3" }}>Kiva</span>
          <span style={{ color: "#2a2d3a", fontSize: 18 }}>|</span>
          <span style={{ fontSize: 12, color: "#555", letterSpacing: 2, textTransform: "uppercase" }}>Youth Fund Filter</span>
        </div>
        <div style={{ display: "flex", gap: 20, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "#444" }}>Portfolio: <span style={{ color: "#888", fontFamily: "'DM Mono',monospace" }}>{portfolio.length}</span></span>
          <span style={{ fontSize: 12, color: "#555" }}>{statusMsg}</span>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: running ? "#fbbf24" : bootstrapStatus === "ready" ? "#4ade80" : "#555", animation: running ? "pulse 1s infinite" : "none", boxShadow: running ? "0 0 8px #fbbf24" : bootstrapStatus === "ready" ? "0 0 8px #4ade80" : "none" }} />
        </div>
      </div>

      <div style={{ display: "flex", height: "calc(100vh - 64px)" }}>
        {/* Sidebar */}
        <div style={{ width: 300, flexShrink: 0, borderRight: "1px solid #1a1d2a", overflowY: "auto", padding: "24px 20px", display: "flex", flexDirection: "column", gap: 22 }}>

          {/* Batch */}
          <div>
            <div style={{ color: "#555", fontSize: 10, letterSpacing: 2, textTransform: "uppercase", marginBottom: 10 }}>Risk Batch</div>
            {[["BOTH","Both Batches"],["A","Batch A — ≤1% Default"],["B","Batch B — 1.1–2% Default"]].map(([val, label]) => (
              <label key={val} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", padding: "8px 12px", borderRadius: 6, marginBottom: 4, background: cfg.batch === val ? "#131620" : "transparent", border: `1px solid ${cfg.batch === val ? "#2a3050" : "transparent"}` }}>
                <div style={{ width: 16, height: 16, borderRadius: "50%", border: `2px solid ${cfg.batch === val ? "#e8d5a3" : "#2a2d3a"}`, background: cfg.batch === val ? "#e8d5a3" : "transparent", flexShrink: 0 }} />
                <span style={{ fontSize: 13, color: cfg.batch === val ? "#e8d5a3" : "#888" }}>{label}</span>
                <input type="radio" style={{ display: "none" }} checked={cfg.batch === val} onChange={() => setCfg(c => ({ ...c, batch: val }))} />
              </label>
            ))}
            <div style={{ color: "#333", fontSize: 11, marginTop: 8, paddingLeft: 4 }}>Server-side: riskRating/defaultRate MinMaxRangeInput {"{ min, max }"}</div>
          </div>

          <div style={{ borderTop: "1px solid #1a1d2a" }} />

          {/* Age */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div style={{ color: "#555", fontSize: 10, letterSpacing: 2, textTransform: "uppercase" }}>Age Filter</div>
              <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                <div style={{ width: 32, height: 18, borderRadius: 9, background: cfg.ageFilter ? "#2d6a4f" : "#1e2030", position: "relative" }}>
                  <div style={{ position: "absolute", top: 2, left: cfg.ageFilter ? 14 : 2, width: 14, height: 14, borderRadius: "50%", background: cfg.ageFilter ? "#4ade80" : "#555", transition: "all 0.2s" }} />
                </div>
                <input type="checkbox" style={{ display: "none" }} checked={cfg.ageFilter} onChange={e => setCfg(c => ({ ...c, ageFilter: e.target.checked }))} />
              </label>
            </div>
            {cfg.ageFilter && (
              <div style={{ display: "flex", gap: 10 }}>
                {[["minAge","Min"],["maxAge","Max"]].map(([k, l]) => (
                  <div key={k} style={{ flex: 1 }}>
                    <div style={{ color: "#444", fontSize: 11, marginBottom: 4 }}>{l}</div>
                    <input type="number" value={cfg[k]} onChange={e => setCfg(c => ({ ...c, [k]: parseInt(e.target.value) || 0 }))}
                      style={{ width: "100%", background: "#0f1117", border: "1px solid #2a2d3a", borderRadius: 6, color: "#e8d5a3", padding: "6px 10px", fontFamily: "'DM Mono',monospace", fontSize: 14 }} />
                  </div>
                ))}
              </div>
            )}
            <div style={{ color: "#333", fontSize: 11, marginTop: 8 }}>ageAtTimeOfLoan on LoanDirect only; null for field-partner loans</div>
          </div>

          {/* Phrase */}
          <div>
            <div style={{ color: "#555", fontSize: 10, letterSpacing: 2, textTransform: "uppercase", marginBottom: 8 }}>Description Phrase</div>
            <input value={cfg.phrase} onChange={e => setCfg(c => ({ ...c, phrase: e.target.value }))}
              placeholder='e.g. "18 years old"'
              style={{ width: "100%", background: "#0f1117", border: "1px solid #2a2d3a", borderRadius: 6, color: "#e8d5a3", padding: "8px 12px", fontSize: 13 }} />
            <div style={{ color: "#333", fontSize: 11, marginTop: 6 }}>Client-side match on description + descriptionInOriginalLanguage</div>
          </div>

          {/* Term */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <div style={{ color: "#555", fontSize: 10, letterSpacing: 2, textTransform: "uppercase" }}>Max lenderRepaymentTerm</div>
              <span style={{ color: "#e8d5a3", fontFamily: "'DM Mono',monospace", fontSize: 13 }}>{cfg.maxTerm}mo</span>
            </div>
            <input type="range" min={1} max={36} value={cfg.maxTerm} onChange={e => setCfg(c => ({ ...c, maxTerm: parseInt(e.target.value) }))} style={{ width: "100%", accentColor: "#e8d5a3" }} />
            <div style={{ color: "#333", fontSize: 11, marginTop: 4 }}>Server-side: lenderTerm: {"{ max }"}; client also checks lenderRepaymentTerm</div>
          </div>

          {/* Caps */}
          {[["countryCap","Country Cap %"],["partnerCap","Partner Cap %"]].map(([k, l]) => (
            <div key={k}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <div style={{ color: "#555", fontSize: 10, letterSpacing: 2, textTransform: "uppercase" }}>{l}</div>
                <span style={{ color: "#93c5fd", fontFamily: "'DM Mono',monospace", fontSize: 13 }}>{cfg[k]}%</span>
              </div>
              <input type="range" min={1} max={30} value={cfg[k]} onChange={e => setCfg(c => ({ ...c, [k]: parseInt(e.target.value) }))} style={{ width: "100%", accentColor: "#93c5fd" }} />
              <div style={{ color: "#333", fontSize: 11, marginTop: 4 }}>Enforced against my.loans + current run combined</div>
            </div>
          ))}

          <div style={{ borderTop: "1px solid #1a1d2a" }} />

          {/* Excluded sectors */}
          <div>
            <div style={{ color: "#555", fontSize: 10, letterSpacing: 2, textTransform: "uppercase", marginBottom: 6 }}>Excluded Sectors</div>
            <div style={{ color: "#333", fontSize: 11, marginBottom: 10 }}>Client-side only — schema sector filter is inclusion by [Int] ID</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {sectorOptions.map(s => {
                const active = cfg.excludedSectors.includes(s);
                return (
                  <button key={s} onClick={() => setCfg(c => ({ ...c, excludedSectors: active ? c.excludedSectors.filter(x => x !== s) : [...c.excludedSectors, s] }))}
                    style={{ padding: "4px 10px", borderRadius: 4, border: "1px solid", borderColor: active ? "#5c1a1a" : "#2a2d3a", background: active ? "#3d1a1a" : "transparent", color: active ? "#f87171" : "#666", fontSize: 12, cursor: "pointer" }}>
                    {s}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Run */}
          <button onClick={runFilter} disabled={running || bootstrapStatus !== "ready"} style={{
            background: running ? "#6b4e10" : "#c8991f", color: "#0a0c12",
            border: "none", borderRadius: 8, padding: "14px 0",
            fontSize: 14, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase",
            cursor: running || bootstrapStatus !== "ready" ? "not-allowed" : "pointer",
            opacity: running || bootstrapStatus !== "ready" ? 0.6 : 1,
            width: "100%", transition: "background 0.2s",
          }}>
            {running ? "⟳  Scanning…" : bootstrapStatus === "loading" ? "Loading portfolio…" : "▶  Run Filter"}
          </button>
        </div>

        {/* Main panel */}
        <div style={{ flex: 1, overflowY: "auto", padding: "24px 28px" }}>
          {!hasRun && !running && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 16, opacity: 0.35 }}>
              <div style={{ fontSize: 48 }}>◈</div>
              <div style={{ color: "#555", letterSpacing: 2, textTransform: "uppercase", fontSize: 13 }}>Configure filters and press Run</div>
            </div>
          )}

          {running && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 16 }}>
              <div style={{ width: 48, height: 48, border: "3px solid #1e2030", borderTopColor: "#e8d5a3", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
              <div style={{ color: "#e8d5a3", letterSpacing: 2, textTransform: "uppercase", fontSize: 12 }}>{statusMsg}</div>
            </div>
          )}

          {hasRun && !running && (
            <div className="fade-in">
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 28 }}>
                <StatCard label="Passing"      value={passing.length}                                   accent="#4ade80" />
                <StatCard label="Failing"       value={failing.length}                                   accent="#f87171" />
                <StatCard label="Total to Lend" value={`$${totalLend.toLocaleString()}`}                 accent="#e8d5a3" />
                <StatCard label="Batch A"       value={batchACount}                                      accent="#60a5fa" />
                <StatCard label="Batch B"       value={batchBCount}                                      accent="#fbbf24" />
                <StatCard label="Pass Rate"     value={`${filtered.length ? Math.round(passing.length / filtered.length * 100) : 0}%`} accent="#a78bfa" />
              </div>

              <div style={{ display: "flex", marginBottom: 20, borderBottom: "1px solid #1a1d2a" }}>
                {[["results","Results"],["breakdown","Country / Partner"]].map(([id, label]) => (
                  <button key={id} onClick={() => setActiveTab(id)} style={{ padding: "10px 20px", background: "transparent", border: "none", borderBottom: `2px solid ${activeTab === id ? "#e8d5a3" : "transparent"}`, color: activeTab === id ? "#e8d5a3" : "#555", fontSize: 13, cursor: "pointer", marginBottom: -1 }}>{label}</button>
                ))}
              </div>

              {activeTab === "results" && (
                <>
                  <div style={{ display: "flex", gap: 12, marginBottom: 16, alignItems: "center" }}>
                    <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name, country, ID…"
                      style={{ flex: 1, background: "#0f1117", border: "1px solid #2a2d3a", borderRadius: 6, color: "#e8d5a3", padding: "8px 14px", fontSize: 13 }} />
                    <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, color: "#888", whiteSpace: "nowrap" }}>
                      <input type="checkbox" checked={cfg.showFailing} onChange={e => setCfg(c => ({ ...c, showFailing: e.target.checked }))} style={{ accentColor: "#e8d5a3" }} />
                      Show failing
                    </label>
                    <span style={{ fontSize: 12, color: "#444", whiteSpace: "nowrap" }}>{shown.length} rows</span>
                  </div>
                  <div style={{ overflowX: "auto", borderRadius: 8, border: "1px solid #1a1d2a" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr style={{ background: "#0c0e18", borderBottom: "1px solid #1a1d2a" }}>
                          {["ID","Borrower","Age","Country","Risk","Default","Term","Tier","Lend","Status"].map(h => (
                            <th key={h} style={{ padding: "10px 14px", textAlign: "left", color: "#444", fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase", fontWeight: 500 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {shown.length === 0 && <tr><td colSpan={10} style={{ padding: 40, textAlign: "center", color: "#444", fontSize: 13 }}>No loans match current filters.</td></tr>}
                        {shown.map((loan, i) => <LoanRow key={loan.id} loan={loan} index={i} expanded={expanded === loan.id} onExpand={id => setExpanded(p => p === id ? null : id)} />)}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {activeTab === "breakdown" && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
                  {[["Country","country",cfg.countryCap],["Partner","partner",cfg.partnerCap]].map(([title, key, cap]) => {
                    const portCounts = {}, newCounts = {};
                    portfolio.forEach(l => { portCounts[l[key]] = (portCounts[l[key]] || 0) + 1; });
                    passing.forEach(l => { newCounts[l[key]] = (newCounts[l[key]] || 0) + 1; });
                    const total = (portfolio.length + passing.length) || 1;
                    const sorted = [...new Set([...Object.keys(portCounts), ...Object.keys(newCounts)])]
                      .map(k => ({ k, pct: ((portCounts[k] || 0) + (newCounts[k] || 0)) / total * 100, portN: portCounts[k] || 0, newN: newCounts[k] || 0 }))
                      .sort((a, b) => b.pct - a.pct).slice(0, 14);
                    return (
                      <div key={title} style={{ background: "#0a0c12", border: "1px solid #1a1d2a", borderRadius: 8, padding: 20 }}>
                        <div style={{ color: "#555", fontSize: 10, letterSpacing: 2, textTransform: "uppercase", marginBottom: 16 }}>{title} Distribution</div>
                        {sorted.map(({ k, pct, portN, newN }) => {
                          const over = pct >= cap, warn = pct >= cap * 0.75;
                          return (
                            <div key={k} style={{ marginBottom: 10 }}>
                              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                                <span style={{ fontSize: 12, color: over ? "#f87171" : "#888", fontFamily: "'DM Mono',monospace" }}>{k}</span>
                                <span style={{ fontSize: 12, color: over ? "#f87171" : warn ? "#fbbf24" : "#555", fontFamily: "'DM Mono',monospace" }}>{pct.toFixed(1)}% {over && "⚠"}</span>
                              </div>
                              <div style={{ height: 4, background: "#1e2030", borderRadius: 2, overflow: "hidden" }}>
                                <div style={{ height: "100%", borderRadius: 2, background: over ? "#f87171" : warn ? "#fbbf24" : "#2d6a4f", width: `${Math.min(pct / cap * 100, 100)}%` }} />
                              </div>
                              <div style={{ display: "flex", gap: 10, marginTop: 3 }}>
                                <span style={{ fontSize: 10, color: "#333" }}>Portfolio: {portN}</span>
                                <span style={{ fontSize: 10, color: "#4ade80" }}>+{newN} new</span>
                              </div>
                            </div>
                          );
                        })}
                        <div style={{ marginTop: 14, padding: "6px 10px", background: "#0f1117", borderRadius: 6, fontSize: 11, color: "#444" }}>
                          Cap: <span style={{ color: "#93c5fd", fontFamily: "'DM Mono',monospace" }}>{cap}%</span>{" · "}Pool: <span style={{ color: "#888", fontFamily: "'DM Mono',monospace" }}>{total}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}