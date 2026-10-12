/* Constants shared by the static build and the application server. */

// Runs before first paint: applies a remembered appearance, marks JS as available.
export const THEME_INIT = `(function(){var d=document.documentElement;d.classList.add('js');try{var t=localStorage.getItem('afflux-theme');if(t==='light'||t==='dark'||t==='deep')d.setAttribute('data-theme',t);}catch(e){}})();`;
// SHA-256 of THEME_INIT, base64. build.mjs recomputes and refuses to build if it drifts.
export const THEME_INIT_HASH = 'sha256-gKCF/KpzxyPOqTYRcsplNa2f7kbw95rBpqT7eiCcHx4=';

export function cspPolicy(opts) {
  const meta = [
    "default-src 'none'",
    `script-src 'self' '${THEME_INIT_HASH}'`,
    "style-src 'self'",
    "font-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'"
  ].join('; ');
  return opts && opts.header ? meta + "; frame-ancestors 'none'" : meta;
}

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
};
