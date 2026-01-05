#!/usr/bin/env python3
"""
Train RandomForest classifier for summit detection.

Uses 5-fold cross-validation to evaluate generalization,
then trains final model on all data and saves to joblib.

Usage:
    python train_summit_model.py --input training_data.csv --output models/summit_model.joblib
"""

import argparse
import json
import os
from typing import Dict, Any, List, Tuple

import numpy as np
import pandas as pd
import joblib
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import cross_val_score, StratifiedKFold
from sklearn.metrics import (
    accuracy_score,
    precision_score,
    recall_score,
    f1_score,
    confusion_matrix,
    classification_report,
)

from extract_features import get_feature_names


def load_training_data(csv_path: str) -> Tuple[np.ndarray, np.ndarray, pd.DataFrame]:
    """
    Load training data from CSV.
    
    Returns:
        X: Feature matrix (n_samples, n_features)
        y: Labels (n_samples,)
        df: Original DataFrame for reference
    """
    df = pd.read_csv(csv_path)
    
    feature_names = get_feature_names()
    X = df[feature_names].values
    y = df["label"].values
    
    return X, y, df


def train_and_evaluate(
    X: np.ndarray,
    y: np.ndarray,
    n_folds: int = 5,
    random_state: int = 42,
) -> Tuple[RandomForestClassifier, Dict[str, Any]]:
    """
    Train RandomForest with cross-validation.
    
    Returns:
        model: Trained classifier
        metrics: Dictionary of evaluation metrics
    """
    # Conservative hyperparameters to prevent overfitting on small dataset
    model = RandomForestClassifier(
        n_estimators=50,           # Fewer trees for small dataset
        max_depth=6,               # Limit depth to prevent overfitting
        min_samples_leaf=5,        # Require at least 5 samples per leaf
        min_samples_split=10,      # Require at least 10 samples to split
        class_weight="balanced",   # Handle class imbalance
        random_state=random_state,
        n_jobs=-1,                 # Use all cores
    )
    
    # 5-fold stratified cross-validation
    cv = StratifiedKFold(n_splits=n_folds, shuffle=True, random_state=random_state)
    
    print(f"\n{'='*60}")
    print(f"CROSS-VALIDATION ({n_folds}-fold)")
    print(f"{'='*60}")
    
    # Collect per-fold metrics
    fold_metrics = {
        "accuracy": [],
        "precision": [],
        "recall": [],
        "f1": [],
    }
    
    for fold_idx, (train_idx, test_idx) in enumerate(cv.split(X, y)):
        X_train, X_test = X[train_idx], X[test_idx]
        y_train, y_test = y[train_idx], y[test_idx]
        
        model.fit(X_train, y_train)
        y_pred = model.predict(X_test)
        
        acc = accuracy_score(y_test, y_pred)
        prec = precision_score(y_test, y_pred)
        rec = recall_score(y_test, y_pred)
        f1 = f1_score(y_test, y_pred)
        
        fold_metrics["accuracy"].append(acc)
        fold_metrics["precision"].append(prec)
        fold_metrics["recall"].append(rec)
        fold_metrics["f1"].append(f1)
        
        print(f"Fold {fold_idx + 1}: Acc={acc:.3f}, Prec={prec:.3f}, Rec={rec:.3f}, F1={f1:.3f}")
    
    # Aggregate metrics
    print(f"\n{'-'*60}")
    print("CROSS-VALIDATION SUMMARY")
    print(f"{'-'*60}")
    
    cv_results = {}
    for metric_name, values in fold_metrics.items():
        mean = np.mean(values)
        std = np.std(values)
        cv_results[f"cv_{metric_name}_mean"] = mean
        cv_results[f"cv_{metric_name}_std"] = std
        print(f"{metric_name.capitalize():12s}: {mean:.3f} ± {std:.3f}")
    
    # Train final model on all data
    print(f"\n{'='*60}")
    print("TRAINING FINAL MODEL ON ALL DATA")
    print(f"{'='*60}")
    
    model.fit(X, y)
    
    # Evaluate on training data (for reference)
    y_pred_train = model.predict(X)
    train_acc = accuracy_score(y, y_pred_train)
    train_prec = precision_score(y, y_pred_train)
    train_rec = recall_score(y, y_pred_train)
    train_f1 = f1_score(y, y_pred_train)
    
    print(f"Training accuracy:  {train_acc:.3f}")
    print(f"Training precision: {train_prec:.3f}")
    print(f"Training recall:    {train_rec:.3f}")
    print(f"Training F1:        {train_f1:.3f}")
    
    cv_results["train_accuracy"] = train_acc
    cv_results["train_precision"] = train_prec
    cv_results["train_recall"] = train_rec
    cv_results["train_f1"] = train_f1
    
    # Confusion matrix
    cm = confusion_matrix(y, y_pred_train)
    print(f"\nConfusion Matrix (on training data):")
    print(f"  True Neg (correct non-summit): {cm[0,0]}")
    print(f"  False Pos (wrong summit):      {cm[0,1]}")
    print(f"  False Neg (missed summit):     {cm[1,0]}")
    print(f"  True Pos (correct summit):     {cm[1,1]}")
    
    # Feature importances
    print(f"\n{'='*60}")
    print("FEATURE IMPORTANCES")
    print(f"{'='*60}")
    
    feature_names = get_feature_names()
    importances = model.feature_importances_
    sorted_idx = np.argsort(importances)[::-1]
    
    for idx in sorted_idx:
        print(f"  {feature_names[idx]:20s}: {importances[idx]:.4f}")
    
    cv_results["feature_importances"] = {
        feature_names[i]: float(importances[i]) for i in range(len(feature_names))
    }
    
    return model, cv_results


def main():
    parser = argparse.ArgumentParser(description="Train ML model for summit detection")
    parser.add_argument("--input", required=True, help="Path to training_data.csv")
    parser.add_argument("--output", default="models/summit_model.joblib", help="Output model path")
    parser.add_argument("--metrics-output", default=None, help="Output JSON for metrics")
    parser.add_argument("--n-folds", type=int, default=5, help="Number of CV folds (default: 5)")
    parser.add_argument("--seed", type=int, default=42, help="Random seed")
    
    args = parser.parse_args()
    
    print("=" * 60)
    print("TRAIN SUMMIT DETECTION MODEL")
    print("=" * 60)
    print(f"Input: {args.input}")
    print(f"Output: {args.output}")
    print(f"CV folds: {args.n_folds}")
    print(f"Random seed: {args.seed}")
    
    # Load data
    print(f"\nLoading training data from {args.input}...")
    X, y, df = load_training_data(args.input)
    
    print(f"Loaded {len(df)} samples")
    print(f"  - Positive (summits): {(y == 1).sum()}")
    print(f"  - Negative (non-summits): {(y == 0).sum()}")
    print(f"  - Features: {X.shape[1]}")
    
    # Check for NaN/inf
    if np.any(np.isnan(X)) or np.any(np.isinf(X)):
        print("\nWARNING: Found NaN/Inf values in features!")
        nan_cols = np.any(np.isnan(X), axis=0)
        inf_cols = np.any(np.isinf(X), axis=0)
        feature_names = get_feature_names()
        for i, (has_nan, has_inf) in enumerate(zip(nan_cols, inf_cols)):
            if has_nan or has_inf:
                print(f"  - {feature_names[i]}: nan={has_nan}, inf={has_inf}")
        
        # Replace with 0 for now
        X = np.nan_to_num(X, nan=0.0, posinf=0.0, neginf=0.0)
        print("  Replaced with 0.0")
    
    # Train model
    model, metrics = train_and_evaluate(X, y, n_folds=args.n_folds, random_state=args.seed)
    
    # Save model
    os.makedirs(os.path.dirname(args.output) if os.path.dirname(args.output) else ".", exist_ok=True)
    joblib.dump(model, args.output)
    print(f"\n{'='*60}")
    print(f"Model saved to: {args.output}")
    
    # Save metrics
    if args.metrics_output:
        with open(args.metrics_output, "w") as f:
            json.dump(metrics, f, indent=2)
        print(f"Metrics saved to: {args.metrics_output}")
    
    # Final summary
    print(f"\n{'='*60}")
    print("SUMMARY")
    print(f"{'='*60}")
    print(f"CV Accuracy:  {metrics['cv_accuracy_mean']:.3f} ± {metrics['cv_accuracy_std']:.3f}")
    print(f"CV F1 Score:  {metrics['cv_f1_mean']:.3f} ± {metrics['cv_f1_std']:.3f}")
    print()
    
    if metrics["cv_accuracy_mean"] >= 0.90:
        print("✓ Model meets accuracy target (>= 90%)")
    else:
        print("⚠ Model below accuracy target (< 90%)")
    
    print(f"\nModel ready for inference at: {args.output}")


if __name__ == "__main__":
    main()

