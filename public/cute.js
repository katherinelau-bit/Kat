/* Cute little characters for the bill and trip cards: one per category (public/wrapped.js keys) plus trips.
 * Each is a 40 x 40 SVG with dot eyes, pink cheeks and a smile, drawn in soft pastels with a dark outline. */
(function (root) {
  var O = '#3b2f4a', BLUSH = '#ff8fab';
  // The face every character shares: eyes, cheeks and a smile centred at (x, y); s scales it.
  function face(x, y, s, sleepy) {
    s = s || 1;
    var ex = 4.2 * s, eyes = sleepy
      ? '<path d="M' + (x - ex - 1.6 * s) + ' ' + y + ' q' + 1.6 * s + ' ' + 1.4 * s + ' ' + 3.2 * s + ' 0 M' + (x + ex - 1.6 * s) + ' ' + y + ' q' + 1.6 * s + ' ' + 1.4 * s + ' ' + 3.2 * s + ' 0" stroke="' + O + '" stroke-width="1.5" fill="none" stroke-linecap="round"/>'
      : '<circle cx="' + (x - ex) + '" cy="' + y + '" r="' + 1.5 * s + '" fill="' + O + '"/><circle cx="' + (x + ex) + '" cy="' + y + '" r="' + 1.5 * s + '" fill="' + O + '"/>' +
        '<circle cx="' + (x - ex + 0.5 * s) + '" cy="' + (y - 0.5 * s) + '" r="' + 0.45 * s + '" fill="#fff"/><circle cx="' + (x + ex + 0.5 * s) + '" cy="' + (y - 0.5 * s) + '" r="' + 0.45 * s + '" fill="#fff"/>';
    return eyes +
      '<ellipse cx="' + (x - ex - 2.6 * s) + '" cy="' + (y + 2.6 * s) + '" rx="' + 1.9 * s + '" ry="' + 1.1 * s + '" fill="' + BLUSH + '" opacity=".75"/>' +
      '<ellipse cx="' + (x + ex + 2.6 * s) + '" cy="' + (y + 2.6 * s) + '" rx="' + 1.9 * s + '" ry="' + 1.1 * s + '" fill="' + BLUSH + '" opacity=".75"/>' +
      '<path d="M' + (x - 1.8 * s) + ' ' + (y + 2.2 * s) + ' q' + 1.8 * s + ' ' + 1.9 * s + ' ' + 3.6 * s + ' 0" stroke="' + O + '" stroke-width="1.4" fill="none" stroke-linecap="round"/>';
  }
  var st = 'stroke="' + O + '" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"';
  // The trip character: a smiling airplane.
  var PLANE = '<path d="M9 18L6.5 10.5h4.5l6 7.5z" fill="#ffb3c7" ' + st + '/><rect x="5" y="17" width="31" height="10" rx="5" fill="#9cc9ff" ' + st + '/>' +
      '<path d="M15 25l-3 8h4.5l7-8z" fill="#ffb3c7" ' + st + '/><circle cx="12" cy="21.5" r="1.3" fill="#fff" ' + st + '/><circle cx="16.5" cy="21.5" r="1.3" fill="#fff" ' + st + '/>' + face(27.5, 21, .7);
  var ART = {
    // A happy noodle bowl with chopsticks and steam.
    food: '<path d="M14 6c-1.5 2 1.5 3 0 5M20 5c-1.5 2 1.5 3 0 5" ' + st + ' fill="none" opacity=".6"/><path d="M25 4l8 9M29 3l6 9" ' + st + ' fill="none"/>' +
      '<path d="M5 17h30a15 15 0 0 1-30 0z" fill="#ffb27a" ' + st + '/><path d="M8 17c3-3 6 0 9-2s6 0 9-2 5 1 7 1" fill="none" stroke="#f6d365" stroke-width="2.2" stroke-linecap="round"/>' + face(20, 24, 1),
    // A round little car.
    transport: '<path d="M5 26v-5c0-2 1-3 3-3l4-6c1-1.5 2-2 4-2h8c2 0 3 .5 4 2l4 6c2 0 3 1 3 3v5z" fill="#86b8ff" ' + st + '/><path d="M14 18l3-5h6l3 5z" fill="#e8f4ff" ' + st + '/>' +
      '<circle cx="12" cy="27" r="4" fill="#5c6b8a" ' + st + '/><circle cx="28" cy="27" r="4" fill="#5c6b8a" ' + st + '/>' + face(20, 21.5, .75),
    // A sleepy house with a night cap moon.
    stay: '<path d="M7 18L20 7l13 11" fill="#a58cf5" ' + st + '/><path d="M10 16v17h20V16" fill="#d3c6ff" ' + st + '/><path d="M30 6a3.5 3.5 0 1 0 3 5 4 4 0 0 1-3-5z" fill="#ffd45e" ' + st + '/>' + face(20, 23, 1, true),
    // A shopping bag with a bow.
    shopping: '<path d="M14 13v-2a6 6 0 0 1 12 0v2" fill="none" ' + st + '/><path d="M8 13h24l-2 21H10z" fill="#ff9fc0" ' + st + '/><path d="M17 13l3 3 3-3" fill="#fff" ' + st + '/>' + face(20, 24, 1),
    // A shiny apple with a leaf.
    groceries: '<path d="M20 12c-3-3-11-2-11 7 0 8 5 14 11 12 6 2 11-4 11-12 0-9-8-10-11-7z" fill="#ff8a80" ' + st + '/><path d="M20 12c0-3 1-5 3-6" fill="none" ' + st + '/><path d="M21 9c2-3 6-3 7-1-2 2-5 2-7 1z" fill="#8fd694" ' + st + '/>' + face(20, 21, 1),
    // A smiling star.
    fun: '<path d="M20 4l4.6 9.6 10.4 1.4-7.6 7.2 1.9 10.4L20 27.6l-9.3 5 1.9-10.4L5 15l10.4-1.4z" fill="#ffd45e" ' + st + '/>' + face(20, 19.5, .9),
    // A receipt with a zigzag edge.
    bills: '<path d="M10 5h20v28l-3.3-2-3.3 2-3.4-2-3.3 2-3.4-2L10 33z" fill="#a7ead8" ' + st + '/><path d="M14 11h12M14 15h8" ' + st + ' fill="none" opacity=".6"/>' + face(20, 23, .95),
    // A gold coin.
    other: '<circle cx="20" cy="20" r="14" fill="#ffd45e" ' + st + '/><circle cx="20" cy="20" r="10.5" fill="none" stroke="#e8a93a" stroke-width="1.5"/>' + face(20, 19, 1),
    // Trips.
    trip: PLANE
  };
  // The soft circle behind each character.
  var BG = { food: '#fff1e6', transport: '#e8f1ff', stay: '#f0ebff', shopping: '#ffeef4', groceries: '#ffeeec', fun: '#fff7dc', bills: '#e6f8f2', other: '#fff7dc', trip: '#e6f4ff' };
  function svg(key) { return '<svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true">' + (ART[key] || ART.other) + '</svg>'; }
  root.Cute = { svg: svg, bg: function (key) { return BG[key] || BG.other; }, keys: Object.keys(ART) };
})(typeof self !== 'undefined' ? self : this);
