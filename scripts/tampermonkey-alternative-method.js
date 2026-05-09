// ==UserScript==
// @name         Way-Danz
// @namespace    https://github.com/Danz-Pro/Way-Danz
// @version      4.0
// @description  Optimized Wayground Cheat Engine v4.0 - Multi-API answer fetching, BLANK support, robust matching
// @author       Danz-Pro
// @match        https://wayground.com/*
// @match        https://*.wayground.com/*
// @icon         https://cf.quizizz.com/img/wayground/brand/favicon/favicon-32x32.ico
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/Danz-Pro/Way-Danz/main/dist/bundle.js
// @downloadURL  https://raw.githubusercontent.com/Danz-Pro/Way-Danz/main/dist/bundle.js
// ==/UserScript==

(function() {
  'use strict';

  // Wait for Vue 3 app to be fully mounted before injecting
  const waitForVue = () => {
    return new Promise((resolve) => {
      const check = () => {
        const root = document.querySelector('#root') || document.querySelector('#app');
        if (root && root.__vue_app__) {
          console.log('[Way-Danz v4.0] Vue 3 app detected, loading cheat engine...');
          resolve(true);
        } else {
          setTimeout(check, 500);
        }
      };
      check();
    });
  };

  const loadScript = async () => {
    await waitForVue();

    try {
      const response = await fetch('https://raw.githubusercontent.com/Danz-Pro/Way-Danz/main/dist/bundle.js');
      const code = await response.text();
      eval(code);
    } catch (err) {
      console.error('[Way-Danz v4.0] Failed to load cheat engine:', err);
    }
  };

  loadScript();
})();
