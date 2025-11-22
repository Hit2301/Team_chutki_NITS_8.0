// apiBase.js
// Frontend will use this to build API requests. Use REACT_APP_API_URL env var in dev/production.
const API_BASE = process.env.REACT_APP_API_URL || "http://127.0.0.1:5005";
export default API_BASE;
