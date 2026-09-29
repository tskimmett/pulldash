import { useCallback } from "react";
import { Sun, Moon, Monitor } from "lucide-react";
import {
  getTheme,
  nextTheme,
  setTheme,
  useTheme,
  type Theme,
} from "../lib/theme";

const LABELS: Record<Theme, string> = {
  light: "Light theme",
  dark: "Dark theme",
  system: "System theme",
};

/**
 * Small always-visible control in the tab bar. Clicking cycles
 * light -> dark -> system.
 */
export function ThemeToggle() {
  const theme = useTheme();

  const handleClick = useCallback(() => {
    setTheme(nextTheme(getTheme()));
  }, []);

  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;

  return (
    <button
      type="button"
      onClick={handleClick}
      className="flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/5 transition-colors"
      title={`${LABELS[theme]} (click to change)`}
      aria-label={LABELS[theme]}
    >
      <Icon className="w-4 h-4" />
    </button>
  );
}
