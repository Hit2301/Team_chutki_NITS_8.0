// src/pages/Home.js - PERFECTED VERSION
import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { auth, db } from "../firebase";
import { collection, getDocs, deleteDoc, doc } from "firebase/firestore";
import NewFarm from "./NewFarm";
import "./Home.css";

export default function Home() {
  const [farms, setFarms] = useState([]);
  const [showNewFarm, setShowNewFarm] = useState(false);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  const fetchFarms = async () => {
    const user = auth.currentUser;
    if (!user) {
      setFarms([]);
      setLoading(false);
      return;
    }

    try {
      const farmsRef = collection(db, "users", user.uid, "farms");
      const snapshot = await getDocs(farmsRef);
      const farmsList = snapshot.docs.map((d) => ({ 
        id: d.id, 
        ...d.data() 
      }));
      setFarms(farmsList);
    } catch (err) {
      console.error("Error loading farms:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFarms();
  }, []);

  const handleFarmSave = () => {
    setShowNewFarm(false);
    fetchFarms();
  };

  const handleDelete = async (farmId, farmName) => {
    if (!window.confirm(`Are you sure you want to delete "${farmName}"?`)) {
      return;
    }

    const user = auth.currentUser;
    if (!user) return;
    
    try {
      await deleteDoc(doc(db, "users", user.uid, "farms", farmId));
      fetchFarms();
    } catch (err) {
      console.error("Error deleting farm:", err);
      alert("Error deleting farm. Please try again.");
    }
  };

  if (showNewFarm) {
    return <NewFarm onSave={handleFarmSave} onCancel={() => setShowNewFarm(false)} />;
  }

  if (loading) {
    return (
      <div className="home-container">
        <div className="loading">
          <div className="loading-spinner"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="home-container">
      {/* Header */}
      <div className="home-header">
        <h1 className="home-title">My Farms</h1>
        <p className="home-subtitle">Manage your crop monitoring farms</p>
      </div>

      {/* Stats Overview */}
      <div className="stats-overview">
        <div className="stat-card">
          <div className="stat-value">{farms.length}</div>
          <div className="stat-label">Total Farms</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">0</div>
          <div className="stat-label">Active Monitoring</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">0</div>
          <div className="stat-label">Alerts</div>
        </div>
      </div>

      {/* Farm List */}
      <div className="farm-list-section">
        <div className="section-header">
          <h2 className="section-title">Your Farms</h2>
          <button 
            className="btn btn-primary"
            onClick={() => setShowNewFarm(true)}
          >
            + Add New Farm
          </button>
        </div>

        {farms.length > 0 ? (
          <div className="farm-list">
            {farms.map((farm) => (
              <div
                key={farm.id}
                className="farm-item"
                onClick={() => navigate(`/farm/${farm.id}`)}
              >
                <div className="farm-info">
                  <h3 className="farm-name">{farm.name}</h3>
                  <p className="farm-date">
                    Created: {farm.date || "Unknown date"}
                  </p>
                </div>
                <div className="farm-actions">
                  <button
                    className="btn btn-danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(farm.id, farm.name);
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <div className="empty-state-icon">🌱</div>
            <h3>No farms yet</h3>
            <p>Get started by creating your first farm</p>
            <button 
              className="btn btn-primary mt-3"
              onClick={() => setShowNewFarm(true)}
            >
              + Create Your First Farm
            </button>
          </div>
        )}
      </div>
    </div>
  );
}