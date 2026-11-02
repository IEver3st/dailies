import { createRoot } from "react-dom/client";
import { Tooltip } from "radix-ui";
import "./styles.css";
import { App } from "./App";
import { installTheme } from "./lib/theme";

installTheme();

createRoot(document.getElementById("root")!).render(
  <Tooltip.Provider>
    <App />
  </Tooltip.Provider>,
);
