// src/pages/NewFarm.js
import React, { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet-draw";
import "leaflet-draw/dist/leaflet.draw.css";
import { auth, db } from "../firebase";
import { collection, addDoc } from "firebase/firestore";
import "./NewFarm.css";

export default function NewFarm({ onSave, onCancel }) {
  const mapRef = useRef(null);
  const leafletMap = useRef(null);
  const drawnItemsRef = useRef(new L.FeatureGroup());

  // farm + polygon state
  const [farmName, setFarmName] = useState("");
  const [coordinates, setCoordinates] = useState([]);

  // dropdown form state
  const [formData, setFormData] = useState({
    soilType: "",
    soilTexture: "",
    soilDepth: "",
    soilMoisture: "",
    ph: "",
    organic: "",
    previousCrop: "",
    repeatedCrop: "",
    residue: "",
    fertilizer: "",
  });

  // live location refs / state
  const watchIdRef = useRef(null);
  const markerRef = useRef(null);
  const accuracyCircleRef = useRef(null);
  const firstFixRef = useRef(true);
  const [isTracking, setIsTracking] = useState(false);

  // Initialize map + draw tools (same as original)
  useEffect(() => {
    if (mapRef.current && !leafletMap.current) {
      const standardMap = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png");
      const satelliteMap = L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
      );
      const labels = L.tileLayer("https://stamen-tiles.a.ssl.fastly.net/toner-labels/{z}/{x}/{y}.png");

      const map = L.map(mapRef.current, {
        center: [23.0225, 72.5714],
        zoom: 15,
        layers: [satelliteMap, labels],
      });

      const baseMaps = { Standard: standardMap, Satellite: satelliteMap };
      const overlayMaps = { Labels: labels };
      L.control.layers(baseMaps, overlayMaps, { collapsed: false }).addTo(map);

      // drawing tools
      const drawnItems = drawnItemsRef.current;
      map.addLayer(drawnItems);
      const drawControl = new L.Control.Draw({
        draw: {
          polygon: true,
          rectangle: true,
          circle: false,
          marker: false,
          polyline: false,
          circlemarker: false,
        },
        edit: { featureGroup: drawnItems },
      });
      map.addControl(drawControl);

      map.on(L.Draw.Event.CREATED, (event) => {
        const layer = event.layer;
        drawnItems.clearLayers();
        drawnItems.addLayer(layer);

        // handle polygons/rectangles robustly
        let coords = [];
        if (layer.getLatLngs) {
          const latLngs = layer.getLatLngs();
          const ring = Array.isArray(latLngs[0]) ? latLngs[0] : latLngs;
          coords = ring.map((pt) => ({ lat: pt.lat, lng: pt.lng }));
        } else if (layer.getLatLng) {
          const pt = layer.getLatLng();
          coords = [{ lat: pt.lat, lng: pt.lng }];
        }
        setCoordinates(coords);
      });

      leafletMap.current = map;
      // ensure proper render
      setTimeout(() => map.invalidateSize(), 500);
    }

    return () => {
      // cleanup map on unmount
      if (leafletMap.current) {
        // stop any active watch
        if (watchIdRef.current !== null && navigator.geolocation) {
          navigator.geolocation.clearWatch(watchIdRef.current);
          watchIdRef.current = null;
        }

        // remove marker & circle
        try {
          if (markerRef.current && leafletMap.current.hasLayer(markerRef.current)) {
            leafletMap.current.removeLayer(markerRef.current);
            markerRef.current = null;
          }
          if (accuracyCircleRef.current && leafletMap.current.hasLayer(accuracyCircleRef.current)) {
            leafletMap.current.removeLayer(accuracyCircleRef.current);
            accuracyCircleRef.current = null;
          }
        } catch (e) {
          // ignore
        }

        leafletMap.current.remove();
        leafletMap.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // form handler
  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((p) => ({ ...p, [name]: value }));
  };

  // Save farm to Firestore
  const handleSave = async () => {
    if (!farmName || coordinates.length === 0) {
      alert("⚠️ Please enter a farm name and draw/select an area on the map.");
      return;
    }

    const newFarm = {
      name: farmName,
      date: new Date().toISOString().split("T")[0],
      coordinates,
      details: formData,
    };

    const user = auth.currentUser;
    if (user) {
      try {
        const farmsRef = collection(db, "users", user.uid, "farms");
        await addDoc(farmsRef, newFarm);
        console.log("💾 Farm saved:", newFarm);
        alert("✅ Farm saved successfully!");
        if (onSave) onSave(newFarm);
      } catch (err) {
        console.error("❌ Error saving:", err);
        alert("❌ Error saving farm: " + (err.message || err));
      }
    } else {
      alert("⚠️ Please sign-in to save the farm.");
    }
  };

  // Start live tracking (watchPosition)
  const startLiveTracking = () => {
    if (!leafletMap.current) {
      alert("Map not ready yet.");
      return;
    }
    if (!navigator.geolocation) {
      alert("Geolocation is not supported by this browser.");
      return;
    }

    firstFixRef.current = true;

    const options = {
      enableHighAccuracy: true,
      maximumAge: 1000,
      timeout: 10000,
    };

    const success = (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const accuracy = pos.coords.accuracy || 0;
      const latlng = [lat, lng];

      // create or update marker
      if (!markerRef.current) {
        const blueDot = L.divIcon({
          className: "location-dot-blue",
          iconSize: [18, 18],
          iconAnchor: [9, 9],
        });
        markerRef.current = L.marker(latlng, { icon: blueDot }).addTo(leafletMap.current);
        markerRef.current.bindPopup("Tracking: You are here").openPopup();
      } else {
        markerRef.current.setLatLng(latlng);
      }

      // create or update accuracy circle
      if (!accuracyCircleRef.current) {
        accuracyCircleRef.current = L.circle(latlng, {
          radius: accuracy,
          color: "#1f6feb55",
          fillColor: "#1f6feb33",
          weight: 1,
        }).addTo(leafletMap.current);
      } else {
        accuracyCircleRef.current.setLatLng(latlng);
        accuracyCircleRef.current.setRadius(accuracy);
      }

      // on first fix, set view; afterwards pan smoothly
      if (firstFixRef.current) {
        leafletMap.current.setView(latlng, 17);
        firstFixRef.current = false;
      } else {
        // pan to new location for smooth follow
        leafletMap.current.panTo(latlng, { animate: true, duration: 0.7 });
      }
    };

    const error = (err) => {
      console.error("Geolocation watch error", err);
      if (err.code === 1) alert("Permission denied for location.");
      else alert("Could not get location: " + (err.message || err.code));
      // stop tracking on persistent errors
      stopLiveTracking();
    };

    const id = navigator.geolocation.watchPosition(success, error, options);
    watchIdRef.current = id;
    setIsTracking(true);
  };

  // Stop live tracking (clear watch)
  const stopLiveTracking = () => {
    if (watchIdRef.current !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    // change icon to green persistent marker (if marker exists)
    if (markerRef.current) {
      const greenDot = L.divIcon({
        className: "location-dot-green",
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      });
      markerRef.current.setIcon(greenDot);
      markerRef.current.bindPopup("Last known location").openPopup();
    }
    // keep accuracy circle visible but reduce opacity OR remove it
    if (accuracyCircleRef.current && leafletMap.current) {
      try {
        leafletMap.current.removeLayer(accuracyCircleRef.current);
        accuracyCircleRef.current = null;
      } catch (e) {}
    }
    setIsTracking(false);
  };

  // Toggle tracking when button clicked
  const toggleTracking = () => {
    if (isTracking) stopLiveTracking();
    else startLiveTracking();
  };

  // Reset form (helper)
  const handleCancel = () => {
    if (onCancel) onCancel();
  };

  return (
    <div className="newfarm-container">
      {/* Sidebar */}
      <div className="newfarm-sidebar">
        <h2>➕ Add New Farm</h2>
        <input
          type="text"
          placeholder="Farm Name"
          value={farmName}
          onChange={(e) => setFarmName(e.target.value)}
          className="newfarm-input"
        />

        {/* Dropdown form */}
        <div className="form-section">
          <h3>Soil & Crop Details</h3>

          <select name="soilType" value={formData.soilType} onChange={handleChange} className="newfarm-select">
            <option value="">Soil Type</option>
            <option>Clay</option>
            <option>Sandy</option>
            <option>Loamy</option>
            <option>Black Cotton</option>
            <option>Red soil</option>
          </select>

          <select name="soilTexture" value={formData.soilTexture} onChange={handleChange} className="newfarm-select">
            <option value="">Soil Texture</option>
            <option>Fine</option>
            <option>Medium</option>
            <option>Coarse</option>
          </select>

          <select name="soilDepth" value={formData.soilDepth} onChange={handleChange} className="newfarm-select">
            <option value="">Soil Depth</option>
            <option>Shallow (&lt;1 ft)</option>
            <option>Medium (1–3 ft)</option>
            <option>Deep (&gt;3 ft)</option>
          </select>

          <select name="soilMoisture" value={formData.soilMoisture} onChange={handleChange} className="newfarm-select">
            <option value="">Soil Moisture</option>
            <option>Dry</option>
            <option>Normal</option>
            <option>Wet</option>
          </select>

          <select name="ph" value={formData.ph} onChange={handleChange} className="newfarm-select">
            <option value="">pH</option>
            <option>Acidic (&lt;6)</option>
            <option>Neutral (6–7.5)</option>
            <option>Alkaline (&gt;7.5)</option>
          </select>

          <select name="organic" value={formData.organic} onChange={handleChange} className="newfarm-select">
            <option value="">Organic Matter</option>
            <option>Low</option>
            <option>Medium</option>
            <option>High</option>
          </select>

          <select name="previousCrop" value={formData.previousCrop} onChange={handleChange} className="newfarm-select">
            <option value="">Previous Crop</option>
            <option>Cotton</option>
            <option>Wheat</option>
            <option>Rice</option>
            <option>Maize</option>
            <option>Groundnut</option>
            <option>Vegetables</option>
          </select>

          <select name="repeatedCrop" value={formData.repeatedCrop} onChange={handleChange} className="newfarm-select">
            <option value="">Repeated Crop</option>
            <option>Yes</option>
            <option>No</option>
          </select>

          <select name="residue" value={formData.residue} onChange={handleChange} className="newfarm-select">
            <option value="">Residue Management</option>
            <option>Removed</option>
            <option>Left in field</option>
          </select>

          <select name="fertilizer" value={formData.fertilizer} onChange={handleChange} className="newfarm-select">
            <option value="">Fertilizer Use</option>
            <option>Low</option>
            <option>Medium</option>
            <option>High</option>
          </select>
        </div>

        <div className="newfarm-actions">
          <button onClick={handleSave} className="btn btn-green">
            Save
          </button>
          <button onClick={handleCancel} className="btn btn-gray">
            Cancel
          </button>
        </div>
      </div>

      {/* Map */}
      <div className="newfarm-map">
        <div ref={mapRef} id="map" />
        {/* Bottom-center live location toggle */}
        <button
          className="locate-btn-bottom"
          onClick={toggleTracking}
          title={isTracking ? "Stop live tracking" : "Start live tracking"}
          aria-pressed={isTracking}
        >
          {isTracking ? "🔴 Live" : "📍 Live"}
        </button>
      </div>
    </div>
  );
}
