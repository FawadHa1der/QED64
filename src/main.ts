import "./styles.css";
import { App } from "./app";

// Restore an explicit theme choice before first paint.
const savedTheme = localStorage.getItem("qed64.theme");
if (savedTheme === "dark" || savedTheme === "light") {
  document.documentElement.dataset.theme = savedTheme;
}

new App();
