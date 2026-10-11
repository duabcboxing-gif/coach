/*
 * Optional settings for the coach app.
 *
 * Normally leave apiUrl EMPTY. Instead, send coaches the private "coach link"
 * from the sheet (DUABC Admin › Show coach app link). That link carries the API
 * address after a #, which stays on the phone – so the address is never
 * published in this public GitHub repository.
 *
 * Only fill this in if you deliberately want the API address public.
 */
window.DUABC_CONFIG = {
  apiUrl: ''
};
