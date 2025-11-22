# backend/ml/ml_prepare_dataset.py
# Reads analytics_cache.json and produces a CSV usable for ML training.
# Labels are created automatically based on NDVI mean (simple heuristic).
# Run: python backend/ml/ml_prepare_dataset.py

import json
import os
import math
import datetime
import numpy as np
import pandas as pd

# CACHE_PATH = "backend/analytics_cache.json"

CACHE_PATH = os.environ.get("ANALYTICS_CACHE_PATH", "analytics_cache.json")

# OUT_CSV = "backend/ml/farm_ml_dataset.csv"
OUT_CSV = "ml/farm_ml_dataset.csv"

def safe_get_list(obj, key):
    return obj.get(key, []) if isinstance(obj, dict) else []

def mean_of_timeseries(ts, value_key):
    vals = [p.get(value_key) for p in ts if p.get(value_key) is not None]
    if not vals:
        return None
    return float(np.mean(vals))

def std_of_timeseries(ts, value_key):
    vals = [p.get(value_key) for p in ts if p.get(value_key) is not None]
    if not vals:
        return None
    return float(np.std(vals))

def last_of_timeseries(ts, value_key):
    vals = [p.get(value_key) for p in ts if p.get(value_key) is not None]
    if not vals:
        return None
    return float(vals[-1])

def slope_of_timeseries(ts, value_key):
    # simple linear slope over dates if we have >=2 points
    dates = []
    vals = []
    for p in ts:
        d = p.get("date")
        v = p.get(value_key)
        if d and v is not None:
            try:
                dt = datetime.datetime.strptime(d, "%Y-%m-%d").toordinal()
                dates.append(dt)
                vals.append(float(v))
            except Exception:
                continue
    if len(dates) < 2:
        return None
    try:
        coeffs = np.polyfit(dates, vals, 1)
        return float(coeffs[0])  # slope per day
    except Exception:
        return None

def build_rows(cache):
    rows = []
    for key, entry in cache.items():
        resp = entry.get("response", {})
        # compute features from available time series
        ndvi_ts = safe_get_list(resp, "ndvi_timeseries")
        soil_moisture_ts = safe_get_list(resp, "soil_moisture")
        rainfall_ts = safe_get_list(resp, "rainfall")
        temp_ts = safe_get_list(resp, "temperature")
        canopy_ts = safe_get_list(resp, "canopy_temperature")
        lai_ts = safe_get_list(resp, "lai_timeseries")
        wsi_ts = safe_get_list(resp, "water_stress_index")

        row = {
            "cache_key": key,
            "ndvi_mean": mean_of_timeseries(ndvi_ts, "ndvi"),
            "ndvi_std": std_of_timeseries(ndvi_ts, "ndvi"),
            "ndvi_last": last_of_timeseries(ndvi_ts, "ndvi"),
            "ndvi_slope": slope_of_timeseries(ndvi_ts, "ndvi"),
            "soil_moisture_mean": mean_of_timeseries(soil_moisture_ts, "moisture"),
            "rainfall_mean": mean_of_timeseries(rainfall_ts, "rain_mm"),
            "temp_mean": mean_of_timeseries(temp_ts, "temp"),
            "canopy_temp_mean": mean_of_timeseries(canopy_ts, "canopy_temp"),
            "lai_mean": mean_of_timeseries(lai_ts, "lai"),
            "wsi_mean": mean_of_timeseries(wsi_ts, "wsi"),
        }

        # Simple label heuristic (you can replace this later with real labels)
        # ndvi_mean >=0.5 -> healthy, 0.3-0.5 -> moderate, <0.3 -> stressed
        nd = row["ndvi_mean"]
        if nd is None:
            label = None
        elif nd >= 0.5:
            label = "healthy"
        elif nd >= 0.3:
            label = "moderate"
        else:
            label = "stressed"
        row["label"] = label

        rows.append(row)
    return rows

def main():
    if not os.path.exists(CACHE_PATH):
        print("analytics cache not found:", CACHE_PATH)
        return
    with open(CACHE_PATH, "r", encoding="utf-8") as fh:
        cache = json.load(fh)
    rows = build_rows(cache)
    df = pd.DataFrame(rows)
    # drop rows without label
    df2 = df.dropna(subset=["label"])
    os.makedirs(os.path.dirname(OUT_CSV), exist_ok=True)
    df2.to_csv(OUT_CSV, index=False)
    print("Saved dataset:", OUT_CSV)
    print(df2.head())

if __name__ == "__main__":
    main()
