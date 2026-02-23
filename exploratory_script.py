import requests
import time

GRAPHQL_URL = "https://gateway.production.kiva.org/graphql"

HEADERS = {
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/120.0.0.0 Safari/537.36",
    "Origin": "https://www.kiva.org",
    "Referer": "https://www.kiva.org/lend",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Connection": "keep-alive"
}

session = requests.Session()
session.headers.update(HEADERS)


def fetch_loans(page=1, per_page=20):
    query = f"""
    {{
      fundraisingLoans(limit:{per_page}, pageNumber:{page}, sortBy:mostRecent) {{
        values {{
          __typename
          id
          name
          ... on LoanDirect {{
            ageAtTimeOfLoan
          }}
        }}
      }}
    }}
    """

    try:
        response = session.post(
            GRAPHQL_URL,
            json={"query": query},
            timeout=15
        )

        if response.status_code == 403:
            print("Blocked (403). Kiva is rejecting automated requests.")
            return []

        if response.status_code != 200:
            print(f"STATUS: {response.status_code}")
            print(response.text)
            return []

        data = response.json()

        if "errors" in data:
            print("GraphQL Error:", data["errors"])
            return []

        return data["data"]["fundraisingLoans"]["values"]

    except Exception as e:
        print("Request failed:", e)
        return []


def get_youth_loans(pages=3):
    youth = []

    for page in range(1, pages + 1):
        print(f"Scanning page {page}...")
        loans = fetch_loans(page=page)

        for loan in loans:
            if loan["__typename"] == "LoanDirect":
                age = loan.get("ageAtTimeOfLoan")
                if age and 18 <= age <= 26:
                    youth.append({
                        "id": loan["id"],
                        "name": loan["name"],
                        "age": age
                    })

        time.sleep(1.5)  # polite delay

    return youth

def debug_age_field(pages=2):
    for page in range(1, pages + 1):
        print(f"\n--- Page {page} ---")
        loans = fetch_loans(page=page, per_page=20)

        for loan in loans:
            if loan["__typename"] == "LoanDirect":
                print(
                    f"LoanDirect | ID: {loan['id']} | "
                    f"Name: {loan['name']} | "
                    f"Age: {loan.get('ageAtTimeOfLoan')}"
                )


if __name__ == "__main__":
    debug_age_field(pages=3)