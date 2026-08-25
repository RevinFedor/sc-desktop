const test = require('node:test');
const assert = require('node:assert/strict');

const {
  scMcpSerializeWindows,
  scMcpFlattenWindows,
  scMcpWindowCreateOptions,
} = require('../mcp-window-model.js');

const browserWindows = [
  {
    id: 10,
    type: 'normal',
    state: 'maximized',
    focused: true,
    incognito: false,
    alwaysOnTop: false,
    left: 0,
    top: 0,
    width: 1440,
    height: 900,
    tabs: [
      {
        id: 101,
        windowId: 10,
        index: 0,
        url: 'https://example.test/login',
        title: 'Login',
        active: true,
        highlighted: true,
        pinned: false,
        incognito: false,
        status: 'complete',
        discarded: false,
        autoDiscardable: true,
        audible: false,
        mutedInfo: { muted: false },
      },
    ],
  },
  {
    id: 11,
    type: 'popup',
    state: 'normal',
    focused: false,
    incognito: false,
    alwaysOnTop: false,
    left: 320,
    top: 160,
    width: 520,
    height: 680,
    tabs: [
      {
        id: 201,
        windowId: 11,
        index: 0,
        url: 'https://accounts.google.com/AccountChooser',
        title: 'Choose an account',
        active: true,
        highlighted: true,
        pinned: false,
        incognito: false,
        status: 'complete',
        discarded: false,
        autoDiscardable: true,
        audible: false,
        mutedInfo: { muted: false },
        openerTabId: 101,
      },
    ],
  },
];

test('serializes normal and popup windows with their tabs and bounds', () => {
  const result = scMcpSerializeWindows(browserWindows);

  assert.equal(result.length, 2);
  assert.deepEqual(result[1].bounds, { left: 320, top: 160, width: 520, height: 680 });
  assert.equal(result[1].type, 'popup');
  assert.equal(result[1].tabs[0].windowId, 11);
  assert.equal(result[1].tabs[0].windowType, 'popup');
  assert.equal(result[1].tabs[0].openerTabId, 101);
});

test('flat tab discovery preserves window identity and independent active states', () => {
  const tabs = scMcpFlattenWindows(browserWindows);

  assert.deepEqual(tabs.map(tab => [tab.id, tab.windowId, tab.active]), [
    [101, 10, true],
    [201, 11, true],
  ]);
  assert.equal(tabs[0].windowFocused, true);
  assert.equal(tabs[1].windowFocused, false);
});

test('builds explicit popup window options without dropping zero coordinates', () => {
  assert.deepEqual(scMcpWindowCreateOptions({
    url: 'https://accounts.google.com/AccountChooser',
    type: 'popup',
    focused: false,
    left: 0,
    top: 0,
    width: 520,
    height: 680,
  }), {
    url: 'https://accounts.google.com/AccountChooser',
    type: 'popup',
    focused: false,
    left: 0,
    top: 0,
    width: 520,
    height: 680,
  });
});
