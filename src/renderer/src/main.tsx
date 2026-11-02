import { createRoot } from "react-dom/client";
import { Tooltip } from "radix-ui";
import "./styles.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <Tooltip.Provider>
    <App />
  </Tooltip.Provider>,
);
