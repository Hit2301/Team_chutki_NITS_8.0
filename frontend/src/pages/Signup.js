import React, { useState } from "react";
import { auth, googleProvider, storage } from "../firebase";
import {
  createUserWithEmailAndPassword,
  updateProfile,
  signInWithPopup,
} from "firebase/auth";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { useNavigate, Link } from "react-router-dom";
import "./Login.css"; 

export default function Signup() {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [photo, setPhoto] = useState(null);
  const navigate = useNavigate();

  const handleSignup = async () => {
    try {
      const userCredential = await createUserWithEmailAndPassword(
        auth,
        email,
        password
      );

      let photoURL = null;
      if (photo) {
        const photoRef = ref(storage, `userPhotos/${userCredential.user.uid}`);
        await uploadBytes(photoRef, photo);
        photoURL = await getDownloadURL(photoRef);
      }

      await updateProfile(userCredential.user, {
        displayName: username,
        photoURL,
      });

      navigate("/home"); // ✅ redirect after signup
    } catch (err) {
      alert("⚠️ " + err.message);
    }
  };

  const handleGoogleSignup = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
      navigate("/home");
    } catch (err) {
      alert("⚠️ " + err.message);
    }
  };

  return (
    <div className="auth-bg">
      <div className="login-card">
        <h1>Sign Up</h1>
        <input
          type="text"
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
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
        <input
          type="file"
          onChange={(e) => setPhoto(e.target.files[0])}
          accept="image/*"
        />
        <button className="login-button" onClick={handleSignup}>
          Sign Up
        </button>
        <button className="google-button" onClick={handleGoogleSignup}>
          <img
            src="https://upload.wikimedia.org/wikipedia/commons/4/4a/Logo_2013_Google.png"
            alt="Google"
          />
          Sign Up with Google
        </button>
        <p className="signup-text">
          Already have an account?{" "}
          <Link to="/login" className="signup-link">
            Login here
          </Link>
        </p>
      </div>
    </div>
  );
}
