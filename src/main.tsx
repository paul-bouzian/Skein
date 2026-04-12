import React from "react";
import ReactDOM from "react-dom/client";
import "./tokens/reset.css";
import "./tokens/tokens.css";
import "./tokens/utilities.css";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
