import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import MockFlightDeck from "./MockFlightDeck";

if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!refreshing) {
      refreshing = true;
      window.location.reload();
    }
  });
}

function Root() {
  const [mockMode, setMockMode] = useState(() =>
    new URLSearchParams(window.location.search).has("mock"),
  );

  if (mockMode) {
    return <MockFlightDeck onExitMock={() => setMockMode(false)} />;
  }

  return <App />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
