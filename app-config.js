(function () {
  'use strict';

  var isGitHubPages = window.location.hostname === 'hemantsatishjadhav06-ai.github.io';
  var apiBase = isGitHubPages ? 'https://to-assistant-logs.onrender.com' : '';
  var sessionKey = 'outletSupport.agentSession';

  function apiUrl(path) {
    if (!apiBase) return path;
    return apiBase + (path.charAt(0) === '/' ? path : '/' + path);
  }

  function pageUrl(fileName) {
    if (isGitHubPages) return new URL(fileName, new URL('./', window.location.href)).href;
    if (fileName === 'index.html') return '/';
    if (fileName === 'login.html') return '/login';
    if (fileName === 'admin.html') return '/admin';
    return '/' + fileName;
  }

  function getSessionToken() {
    try { return window.sessionStorage.getItem(sessionKey) || ''; } catch (_) { return ''; }
  }

  function setSessionToken(token) {
    try {
      if (token) window.sessionStorage.setItem(sessionKey, token);
      else window.sessionStorage.removeItem(sessionKey);
    } catch (_) {}
  }

  function authHeaders() {
    var token = getSessionToken();
    return token ? { 'X-Agent-Session': token } : {};
  }

  window.OutletSupportConfig = {
    apiBase: apiBase,
    apiUrl: apiUrl,
    pageUrl: pageUrl,
    authHeaders: authHeaders,
    setSessionToken: setSessionToken,
    clearSession: function () { setSessionToken(''); }
  };
})();
