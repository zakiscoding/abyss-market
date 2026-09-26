import MarketApp from "./MarketApp";
import MaydayApp from "./mayday/MaydayApp";

const APP = new URLSearchParams(window.location.search).get("app");

/** MAYDAY is the default; the original Abyss market stays at ?app=market. */
export default function App() {
  return APP === "market" ? <MarketApp /> : <MaydayApp />;
}
