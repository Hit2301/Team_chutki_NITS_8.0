# backend/ml/train_model.py
# Train a RandomForest model on the dataset we created.

import pandas as pd
import joblib
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline
from sklearn.metrics import classification_report, accuracy_score
import os

# 🧩 Path to your dataset
CSV = "ml/farm_ml_dataset.csv"   # <- this matches your folder layout
MODEL_PATH = "ml/farm_health_model.pkl"

def main():
    if not os.path.exists(CSV):
        print("❌ Dataset not found:", CSV)
        return

    # 🧠 Load the dataset
    df = pd.read_csv(CSV)

    # Select numeric columns we made earlier
    feature_cols = [
        "ndvi_mean", "ndvi_std", "ndvi_last", "ndvi_slope",
        "soil_moisture_mean", "rainfall_mean", "temp_mean",
        "canopy_temp_mean", "lai_mean", "wsi_mean"
    ]


    # df = df[feature_cols + ["label"]]  # If you just want to test fast


    df = df[feature_cols + ["label"]]
    df = df.fillna(df.mean(numeric_only=True))  # replace missing numeric cells with average

    if len(df) < 5:
        print("⚠️ Not enough rows to train (need at least 5 with labels).")
        return

    X = df[feature_cols]
    y = df["label"]

    # Split for testing
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

    # Build ML pipeline: scale + random forest
    model = Pipeline([
        ("scaler", StandardScaler()),
        ("rf", RandomForestClassifier(n_estimators=150, random_state=42))
    ])

    # Train
    model.fit(X_train, y_train)

    # Evaluate
    y_pred = model.predict(X_test)
    acc = accuracy_score(y_test, y_pred)
    print(f"✅ Training done! Accuracy: {acc*100:.1f}%")
    print(classification_report(y_test, y_pred))

    # Save the model
    joblib.dump(model, MODEL_PATH)
    print(f"💾 Saved model to: {MODEL_PATH}")

if __name__ == "__main__":
    main()
