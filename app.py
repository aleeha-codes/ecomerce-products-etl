"""
Backend server for the E-Commerce Dashboard.

It reuses the functions from ecommerce_pipeline.py (extract, transform,
validate, load) and sends the results to the web page as JSON.

Install: python -m pip install flask
Run:     python app.py
Open:    http://127.0.0.1:5000
"""

import json
import os
from pathlib import Path

import numpy as np
from flask import Flask, jsonify, send_from_directory

import ecommerce_pipeline as pipeline  # your existing code

# Make sure paths work both locally and on Vercel (where only /tmp is writable)
BASE_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = Path("/tmp/output") if os.environ.get("VERCEL") else (BASE_DIR / "output")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
os.environ["OUTPUT_DIR"] = str(OUTPUT_DIR)

app = Flask(__name__, static_folder=str(BASE_DIR / "static"), static_url_path="/static")


def to_records(df):
    """Convert a DataFrame to a list of dicts (NaN becomes null)."""
    return json.loads(df.to_json(orient="records"))


def build_report(clean, rejected):
    """Calculate all the numbers and chart data the web page needs."""
    # Average price / rating per category
    by_category = (
        clean.groupby("category")
        .agg(products=("id", "count"), avg_price=("price", "mean"), avg_rating=("rating", "mean"))
        .round(2)
        .reset_index()
        .sort_values("products", ascending=False)
    )

    # Outliers using the IQR rule
    q1 = clean["price"].quantile(0.25)
    q3 = clean["price"].quantile(0.75)
    upper_limit = q3 + 1.5 * (q3 - q1)
    outliers = (
        clean[clean["price"] > upper_limit][["title", "category", "price"]]
        .sort_values("price", ascending=False)
        .head(10)
    )

    # Price histogram (10 bins)
    counts, edges = np.histogram(clean["price"], bins=10)
    histogram = {
        "labels": [f"{edges[i]:.0f}-{edges[i + 1]:.0f}" for i in range(len(counts))],
        "counts": [int(c) for c in counts],
    }

    # Summary statistics
    summary = {}
    for col in ["price", "discount_pct", "rating", "stock"]:
        stats = clean[col].agg(["mean", "median", "min", "max", "std"]).round(2)
        summary[col] = json.loads(stats.to_json())

    # Correlation matrix
    corr_cols = ["price", "discount_pct", "rating", "stock"]
    corr = clean[corr_cols].corr().round(2)

    return {
        "kpis": {
            "valid": int(len(clean)),
            "rejected": int(len(rejected)),
            "categories": int(clean["category"].nunique()),
            "brands": int(clean["brand"].nunique()),
            "low_stock": int(clean["low_stock"].sum()),
            "avg_price": round(float(clean["price"].mean()), 2),
        },
        "by_category": to_records(by_category),
        "histogram": histogram,
        "scatter": to_records(clean[["title", "price", "rating"]]),
        "availability": json.loads(clean["availability"].value_counts().to_json()),
        "summary": summary,
        "correlation": {"labels": corr_cols, "matrix": json.loads(corr.to_json(orient="values"))},
        "outliers": {"limit": round(float(upper_limit), 2), "rows": to_records(outliers)},
        "products": to_records(
            clean[["id", "title", "category", "brand", "price", "discount_pct",
                   "final_price", "rating", "stock", "availability"]]
        ),
        "rejected": to_records(rejected[["id", "title", "price", "rating", "stock", "problem"]]),
    }


@app.route("/")
def home():
    return send_from_directory(str(BASE_DIR / "static"), "index.html")


@app.route("/api/run")
def run_pipeline():
    """Run the whole pipeline and return the results as JSON."""
    try:
        products = pipeline.extract()
        df = pipeline.transform(products)
        clean, rejected = pipeline.validate(df)
        pipeline.load(clean, rejected)

        if clean.empty:
            raise ValueError("No valid products were found after validation.")

        duplicates = len(df) - len(clean) - len(rejected)
        report = build_report(clean, rejected)
        report["steps"] = [
            {"name": "Extract", "detail": f"{len(products)} products downloaded"},
            {"name": "Transform", "detail": f"{df.shape[0]} rows, {df.shape[1]} columns cleaned"},
            {"name": "Validate", "detail": f"{len(clean)} valid, {len(rejected)} rejected, {duplicates} duplicates removed"},
            {"name": "Load", "detail": f"Saved to CSV and SQLite ({OUTPUT_DIR})"},
            {"name": "EDA", "detail": "Statistics and charts ready"},
        ]
        return jsonify(report)
    except Exception as error:  # show any problem on the web page
        return jsonify({"error": str(error)}), 500


if __name__ == "__main__":
    app.run(debug=True)