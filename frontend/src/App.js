// import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
// import Login from "./pages/Login";
// import Signup from "./pages/Signup";
// import Home from "./pages/Home";
// import FarmDashboard from "./pages/FarmDashboard";
// import FarmInsights from "./pages/FarmInsights";

// function App() {
//   return (
//     <Router>
//       <Routes>
//         <Route path="/" element={<Login />} />
//         <Route path="/login" element={<Login />} />
//         <Route path="/signup" element={<Signup />} />
//         <Route path="/home" element={<Home />} />
//         <Route path="/farm/:id" element={<FarmDashboard />} />
//         <Route path="/farm/:id/insights" element={<FarmInsights />} />
//       </Routes>
//     </Router>
//   );
// }

// export default App;




import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import Landing from "./pages/Landing"; // Add this import
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import Home from "./pages/Home";
import FarmDashboard from "./pages/FarmDashboard";
import FarmInsights from "./pages/FarmInsights";

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Landing />} /> {/* Landing page as root */}
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/home" element={<Home />} />
        <Route path="/farm/:id" element={<FarmDashboard />} />
        <Route path="/farm/:id/insights" element={<FarmInsights />} />
      </Routes>
    </Router>
  );
}

export default App;