// pages/Landing.js
import React from 'react';
import { Link } from 'react-router-dom';
import './Landing.css';
import earthImg from "./earth.png";
import satelliteImg from "./satellite.png";



export default function Landing() {
  return (
    <div className="landing-container">
      {/* Navigation */}
      <nav className="landing-nav">
        <div className="nav-brand">
          <div className="logo-icon">🛰️</div>
          <span className="logo-text">Satellite-Based Crop Health Monitoring</span>
        </div>
        <div className="nav-links">
          <Link to="/login" className="nav-link">Login</Link>
          <Link to="/signup" className="btn btn-outline">Sign Up</Link>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="landing-hero">
        <div className="hero-content">
          <h1 className="hero-title">
            Advanced Satellite
            <span className="highlight"> Crop Monitoring</span>
          </h1>
          <p className="hero-subtitle">
            Monitor your farm's health, track growth patterns, and optimize yields
            with real-time satellite imagery and AI-powered insights.
          </p>
          <div className="hero-actions">
            <Link to="/signup" className="btn btn-primary">
              Get Started
            </Link>
            <Link to="/login" className="btn btn-secondary">
              Existing User
            </Link>
          </div>
        </div>
        <div className="hero-visual">
          <div className="simple-earth-container">

            <img src={earthImg} className="simple-earth" alt="Earth" />
            <div className="ring-container">
              {Array(14).fill(0).map((_, i) => (
                <div className="scan-ring" style={{ "--i": i }}></div>
              ))}
            </div>


            {/* Satellite (attached to beam) */}
            <div className="satellite-holder">
              <img src={satelliteImg} className="simple-satellite" alt="Satellite" />
            </div>
          </div>

        </div>


      </section>

      {/* Features Section */}
      <section className="features-section">
        <div className="container">
          <h2 className="section-title">Why Choose This?</h2>
          <div className="features-grid">
            <div className="feature-card">
              <div className="feature-icon">🌱</div>
              <h3>Crop Health Monitoring</h3>
              <p>Real-time NDVI analysis and vegetation indices to track crop health and detect issues early.</p>
            </div>
            <div className="feature-card">
              <div className="feature-icon">🛰️</div>
              <h3>Satellite Imagery</h3>
              <p>High-resolution satellite data updated regularly for accurate field monitoring.</p>
            </div>
            <div className="feature-card">
              <div className="feature-icon">📊</div>
              <h3>Smart Analytics</h3>
              <p>AI-powered insights and predictive analytics for better decision making.</p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="cta-section">
        <div className="container">
          <h2>Ready to Transform Your Farming?</h2>
          <p>Join thousands of farmers using this for better crop management.</p>
          <Link to="/signup" className="btn btn-primary btn-large">
            Start
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="landing-footer">
        <div className="container">
          <p>&copy; 2025 Advanced Satellite Analytics for Modern Farming</p>
        </div>
      </footer>
    </div>
  );
}
