import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { Results } from "./ui/Results";
import MaydayApp from "./ui/mayday/MaydayApp";
import "./styles.css";
import "./ui/mayday/mayday.css";

const params = new URLSearchParams(window.location.search);
const view = params.get("view") === "results" ? <Results /> : params.get("app") === "market" ? <App /> : <MaydayApp />;

ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode>{view}</React.StrictMode>);
