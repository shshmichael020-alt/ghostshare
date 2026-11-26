export type Theme = "dark" | "light";

export const THEME_STORAGE_KEY = "ghostshare-theme";

/**
 * Inline script executed synchronously in <head> before first paint
 * to prevent any flash of unstyled/wrong theme on page load or refresh.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("${THEME_STORAGE_KEY}");var r=document.documentElement;if(t==="light"){r.classList.remove("dark");r.classList.add("light");r.style.colorScheme="light";}else{r.classList.remove("light");r.classList.add("dark");r.style.colorScheme="dark";}}catch(e){}})();`;
