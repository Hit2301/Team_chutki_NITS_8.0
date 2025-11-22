import React, { useState } from "react";
import { auth, googleProvider } from "../firebase";
import { signInWithEmailAndPassword, signInWithPopup } from "firebase/auth";
import { useNavigate, Link } from "react-router-dom";
import "./Login.css"; 

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false); // ⬅ added
  const [googleLoading, setGoogleLoading] = useState(false); // ⬅ added
  const navigate = useNavigate();

  const handleLogin = async () => {
    if (loading) return; // prevent multiple clicks

    setLoading(true);

    try {
      await signInWithEmailAndPassword(auth, email, password);
      navigate("/home");
    } catch (err) {
      alert("⚠️ " + err.message);
      setLoading(false); // enable button again on error
    }
  };

  const handleGoogleLogin = async () => {
    if (googleLoading) return; // prevent multiple clicks

    setGoogleLoading(true);

    try {
      await signInWithPopup(auth, googleProvider);
      navigate("/home");
    } catch (err) {
      alert("⚠️ " + err.message);
      setGoogleLoading(false);
    }
  };

  return (
    <div className="auth-bg">
      <div className="login-card">
        <h1>Login</h1>

        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        {/* MAIN LOGIN BUTTON */}
        <button 
          className="login-button" 
          onClick={handleLogin}
          disabled={loading}
        >
          {loading ? "Logging in..." : "Login"}
        </button>

        {/* GOOGLE LOGIN BUTTON */}
        <button 
          className="google-button" 
          onClick={handleGoogleLogin}
          disabled={googleLoading}
        >
          <img
            src="https://upload.wikimedia.org/wikipedia/commons/4/4a/Logo_2013_Google.png"
            alt="Google"
          />
          {googleLoading ? "Please wait..." : "Login with Google"}
        </button>

        <p className="signup-text">
          Don’t have an account?{" "}
          <Link to="/signup" className="signup-link">
            Sign up here
          </Link>
        </p>
      </div>
    </div>
  );
}
