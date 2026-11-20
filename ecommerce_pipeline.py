"""
E-Commerce Products: ETL Pipeline + Exploratory Data Analysis

Steps:
1. Extract   - get product data from the DummyJSON API
2. Transform - clean the data and add useful columns
3. Validate  - separate good rows from bad rows
4. Load      - save to CSV and SQLite
5. EDA       - print statistics and save charts

Install: pip install requests pandas matplotlib
Run:     python ecommerce_pipeline.py
"""

import logging
import os
import sqlite3
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd
import requests

API_URL = "https://dummyjson.com/products?limit=0"  # limit=0 -> all products
OUTPUT_DIR = Path("/tmp/output") if os.environ.get("VERCEL") else Path("output")

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
log = logging.getLogger(__name__)


# ---------------------------------------------------------------
# 1. EXTRACT
# ---------------------------------------------------------------
def extract():
    """Download products from the API and return them as a list of dicts."""
    log.info("Fetching data from API...")
    try:
        response = requests.get(API_URL, timeout=15)
        response.raise_for_status()  # raises an error for 404, 500, etc.
    except requests.RequestException as error:
        log.error("API request failed: %s", error)
        raise

    products = response.json()["products"]
    log.info("Extracted %d products", len(products))
    return products


# ---------------------------------------------------------------
# 2. TRANSFORM
# ---------------------------------------------------------------
def transform(products):
    """Turn raw data into a clean DataFrame with the columns we need."""
    df = pd.DataFrame(products)

    # Keep only useful columns
    columns = ["id", "title", "category", "brand", "price",
               "discountPercentage", "rating", "stock", "availabilityStatus"]
    df = df[columns].copy()

    # Rename to snake_case
    df = df.rename(columns={
        "discountPercentage": "discount_pct",
        "availabilityStatus": "availability",
    })

    # Clean text and handle missing values
    df["title"] = df["title"].str.strip()
    df["category"] = df["category"].str.strip().str.lower()
    df["brand"] = df["brand"].fillna("Unknown")

    # Make sure number columns really are numbers
    for col in ["price", "discount_pct", "rating", "stock"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")

    # New columns (feature engineering)
    df["final_price"] = (df["price"] * (1 - df["discount_pct"] / 100)).round(2)
    df["low_stock"] = df["stock"] < 10

    return df


# ---------------------------------------------------------------
# 3. VALIDATE
# ---------------------------------------------------------------
def find_problem(row):
    """Return a reason if the row is bad, otherwise an empty string."""
    if pd.isna(row["price"]) or row["price"] <= 0:
        return "invalid price"
    if pd.isna(row["rating"]) or not 0 <= row["rating"] <= 5:
        return "rating must be between 0 and 5"
    if pd.isna(row["stock"]) or row["stock"] < 0:
        return "invalid stock"
    if not row["title"]:
        return "missing title"
    return ""


def validate(df):
    """Split the data into valid rows and rejected rows."""
    # Remove duplicate ids first
    before = len(df)
    df = df.drop_duplicates(subset="id")
    log.info("Removed %d duplicate rows", before - len(df))

    df = df.copy()
    df["problem"] = df.apply(find_problem, axis=1)

    rejected = df[df["problem"] != ""]
    clean = df[df["problem"] == ""].drop(columns="problem")

    log.info("Validation: %d valid, %d rejected", len(clean), len(rejected))
    return clean, rejected


# ---------------------------------------------------------------
# 4. LOAD
# ---------------------------------------------------------------
def load(clean, rejected):
    """Save the results to CSV files and a SQLite database."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    clean.to_csv(OUTPUT_DIR / "clean_products.csv", index=False)
    rejected.to_csv(OUTPUT_DIR / "rejected_products.csv", index=False)

    with sqlite3.connect(OUTPUT_DIR / "products.db") as conn:
        clean.to_sql("products", conn, if_exists="replace", index=False)

    log.info("Saved files to the '%s' folder", OUTPUT_DIR)


# ---------------------------------------------------------------
# 5. EXPLORATORY DATA ANALYSIS
# ---------------------------------------------------------------
def run_eda(df):
    """Print key statistics and save charts."""
    print("\n===== OVERVIEW =====")
    print("Products:", len(df))
    print("Categories:", df["category"].nunique())
    print("Brands:", df["brand"].nunique())

    print("\n===== NUMERIC SUMMARY =====")
    print(df[["price", "discount_pct", "rating", "stock"]].describe().round(2))

    print("\n===== PRODUCTS PER CATEGORY =====")
    print(df["category"].value_counts().head(10))

    # Group by category: average price and rating
    by_category = df.groupby("category").agg(
        products=("id", "count"),
        avg_price=("price", "mean"),
        avg_rating=("rating", "mean"),
    ).round(2)

    print("\n===== MOST EXPENSIVE CATEGORIES =====")
    print(by_category.sort_values("avg_price", ascending=False).head(5))

    print("\n===== BEST RATED CATEGORIES =====")
    print(by_category.sort_values("avg_rating", ascending=False).head(5))

    # Outliers using the IQR rule
    q1 = df["price"].quantile(0.25)
    q3 = df["price"].quantile(0.75)
    upper_limit = q3 + 1.5 * (q3 - q1)
    outliers = df[df["price"] > upper_limit]
    print(f"\n===== PRICE OUTLIERS (above {upper_limit:.2f}) =====")
    print(outliers[["title", "category", "price"]].head(10))

    print("\n===== LOW STOCK PRODUCTS =====")
    print(f"{df['low_stock'].sum()} products have fewer than 10 units")

    print("\n===== CORRELATIONS =====")
    print(df[["price", "discount_pct", "rating", "stock"]].corr().round(2))

    save_charts(df, by_category)


def save_charts(df, by_category):
    """Create and save three simple charts."""
    # Chart 1: price distribution
    plt.figure(figsize=(7, 4))
    plt.hist(df["price"], bins=30, color="steelblue", edgecolor="white")
    plt.title("Price Distribution")
    plt.xlabel("Price ($)")
    plt.ylabel("Number of products")
    plt.tight_layout()
    plt.savefig(OUTPUT_DIR / "price_distribution.png")
    plt.close()

    # Chart 2: average price per category (top 10)
    top10 = by_category.sort_values("avg_price").tail(10)
    plt.figure(figsize=(7, 5))
    plt.barh(top10.index, top10["avg_price"], color="darkorange")
    plt.title("Average Price by Category (Top 10)")
    plt.xlabel("Average price ($)")
    plt.tight_layout()
    plt.savefig(OUTPUT_DIR / "avg_price_by_category.png")
    plt.close()

    # Chart 3: price vs rating
    plt.figure(figsize=(7, 4))
    plt.scatter(df["price"], df["rating"], alpha=0.6, color="seagreen")
    plt.title("Price vs Rating")
    plt.xlabel("Price ($)")
    plt.ylabel("Rating")
    plt.tight_layout()
    plt.savefig(OUTPUT_DIR / "price_vs_rating.png")
    plt.close()

    log.info("Charts saved")


# ---------------------------------------------------------------
# MAIN
# ---------------------------------------------------------------
def main():
    products = extract()
    df = transform(products)
    clean, rejected = validate(df)
    load(clean, rejected)
    run_eda(clean)


if __name__ == "__main__":
    main()