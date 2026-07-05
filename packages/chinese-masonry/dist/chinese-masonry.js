var fr = Object.defineProperty;
var Ar = (e, t, i) => t in e ? fr(e, t, { enumerable: !0, configurable: !0, writable: !0, value: i }) : e[t] = i;
var Be = (e, t, i) => Ar(e, typeof t != "symbol" ? t + "" : t, i);
import { jsx as A, jsxs as E, Fragment as Bt } from "react/jsx-runtime";
import * as v from "react";
import B, { useRef as Y, useState as G, useMemo as ue, useEffect as W, useCallback as Wt, useLayoutEffect as pr } from "react";
const Q = 0, P = 1, mr = 2, Cr = 0, ft = 1;
function xr(e, t, i) {
  let r = e.list, n;
  for (; r; ) {
    if (r.index === i) return !1;
    if (t > r.high) break;
    n = r, r = r.next;
  }
  return n || (e.list = {
    index: i,
    high: t,
    next: r
  }), n && (n.next = {
    index: i,
    high: t,
    next: n.next
  }), !0;
}
function wr(e, t) {
  let i = e.list;
  if (i.index === t)
    return i.next === null ? Cr : (e.list = i.next, ft);
  let r = i;
  for (i = i.next; i !== null; ) {
    if (i.index === t)
      return r.next = i.next, ft;
    r = i, i = i.next;
  }
}
const S = {
  low: 0,
  max: 0,
  high: 0,
  C: mr,
  // @ts-expect-error
  P: void 0,
  // @ts-expect-error
  R: void 0,
  // @ts-expect-error
  L: void 0,
  // @ts-expect-error
  list: void 0
};
S.P = S;
S.L = S;
S.R = S;
function X(e) {
  const t = e.high;
  e.L === S && e.R === S ? e.max = t : e.L === S ? e.max = Math.max(e.R.max, t) : e.R === S ? e.max = Math.max(e.L.max, t) : e.max = Math.max(Math.max(e.L.max, e.R.max), t);
}
function Pe(e) {
  let t = e;
  for (; t.P !== S; )
    X(t.P), t = t.P;
}
function fe(e, t) {
  if (t.R === S) return;
  const i = t.R;
  t.R = i.L, i.L !== S && (i.L.P = t), i.P = t.P, t.P === S ? e.root = i : t === t.P.L ? t.P.L = i : t.P.R = i, i.L = t, t.P = i, X(t), X(i);
}
function Ae(e, t) {
  if (t.L === S) return;
  const i = t.L;
  t.L = i.R, i.R !== S && (i.R.P = t), i.P = t.P, t.P === S ? e.root = i : t === t.P.R ? t.P.R = i : t.P.L = i, i.R = t, t.P = i, X(t), X(i);
}
function He(e, t, i) {
  t.P === S ? e.root = i : t === t.P.L ? t.P.L = i : t.P.R = i, i.P = t.P;
}
function yr(e, t) {
  let i;
  for (; t !== S && t.C === P; )
    t === t.P.L ? (i = t.P.R, i.C === Q && (i.C = P, t.P.C = Q, fe(e, t.P), i = t.P.R), i.L.C === P && i.R.C === P ? (i.C = Q, t = t.P) : (i.R.C === P && (i.L.C = P, i.C = Q, Ae(e, i), i = t.P.R), i.C = t.P.C, t.P.C = P, i.R.C = P, fe(e, t.P), t = e.root)) : (i = t.P.L, i.C === Q && (i.C = P, t.P.C = Q, Ae(e, t.P), i = t.P.L), i.R.C === P && i.L.C === P ? (i.C = Q, t = t.P) : (i.L.C === P && (i.R.C = P, i.C = Q, fe(e, i), i = t.P.L), i.C = t.P.C, t.P.C = P, i.L.C = P, Ae(e, t.P), t = e.root));
  t.C = P;
}
function br(e) {
  for (; e.L !== S; ) e = e.L;
  return e;
}
function zr(e, t) {
  let i;
  for (; t.P.C === Q; )
    t.P === t.P.P.L ? (i = t.P.P.R, i.C === Q ? (t.P.C = P, i.C = P, t.P.P.C = Q, t = t.P.P) : (t === t.P.R && (t = t.P, fe(e, t)), t.P.C = P, t.P.P.C = Q, Ae(e, t.P.P))) : (i = t.P.P.L, i.C === Q ? (t.P.C = P, i.C = P, t.P.P.C = Q, t = t.P.P) : (t === t.P.L && (t = t.P, Ae(e, t)), t.P.C = P, t.P.P.C = Q, fe(e, t.P.P)));
  e.root.C = P;
}
function Er() {
  const e = {
    root: S,
    size: 0
  }, t = {};
  return {
    insert(i, r, n) {
      let o = e.root, a = S;
      for (; o !== S && (a = o, i !== a.low); )
        i < o.low ? o = o.L : o = o.R;
      if (i === a.low && a !== S) {
        if (!xr(a, r, n)) return;
        a.high = Math.max(a.high, r), X(a), Pe(a), t[n] = a, e.size++;
        return;
      }
      const c = {
        low: i,
        high: r,
        max: r,
        C: Q,
        P: a,
        L: S,
        R: S,
        list: {
          index: n,
          high: r,
          next: null
        }
      };
      a === S ? e.root = c : (c.low < a.low ? a.L = c : a.R = c, Pe(c)), zr(e, c), t[n] = c, e.size++;
    },
    remove(i) {
      const r = t[i];
      if (r === void 0) return;
      delete t[i];
      const n = wr(r, i);
      if (n === void 0) return;
      if (n === ft) {
        r.high = r.list.high, X(r), Pe(r), e.size--;
        return;
      }
      let o = r, a = o.C, c;
      r.L === S ? (c = r.R, He(e, r, r.R)) : r.R === S ? (c = r.L, He(e, r, r.L)) : (o = br(r.R), a = o.C, c = o.R, o.P === r ? c.P = o : (He(e, o, o.R), o.R = r.R, o.R.P = o), He(e, r, o), o.L = r.L, o.L.P = o, o.C = r.C), X(c), Pe(c), a === P && yr(e, c), e.size--;
    },
    search(i, r, n) {
      const o = [e.root];
      for (; o.length !== 0; ) {
        const a = o.pop();
        if (!(a === S || i > a.max) && (a.L !== S && o.push(a.L), a.R !== S && o.push(a.R), a.low <= r && a.high >= i)) {
          let c = a.list;
          for (; c !== null; )
            c.high >= i && n(c.index, a.low), c = c.next;
        }
      }
    },
    get size() {
      return e.size;
    }
  };
}
const Ke = (e) => {
  const t = v.useRef(e);
  return v.useEffect(() => {
    t.current = e;
  }), t;
}, Ir = (e, t = 100, i = !1) => {
  const r = Ke(e), n = v.useRef(), o = [t, i, r];
  function a() {
    n.current && clearTimeout(n.current), n.current = void 0;
  }
  v.useEffect(() => a, o);
  function c() {
    n.current = void 0;
  }
  return v.useCallback(function() {
    const u = arguments, {
      current: l
    } = n;
    if (l === void 0 && i)
      return n.current = setTimeout(c, t), r.current.apply(null, u);
    l && clearTimeout(l), n.current = setTimeout(() => {
      n.current = void 0, r.current.apply(null, u);
    }, t);
  }, o);
}, vr = (e, t, i) => {
  const r = v.useState(e);
  return [r[0], Ir(r[1], t, i)];
};
function pe(e, t, i, r) {
  const n = v.useRef(i), o = v.useRef(r);
  v.useEffect(() => {
    n.current = i, o.current = r;
  }), v.useEffect(() => {
    const a = e && "current" in e ? e.current : e;
    if (!a) return;
    let c = 0;
    function u(...s) {
      c || n.current.apply(this, s);
    }
    a.addEventListener(t, u);
    const l = o.current;
    return () => {
      c = 1, a.removeEventListener(t, u), l && l();
    };
  }, [e, t]);
}
const Lr = {}, me = typeof window > "u" ? null : window, Sr = me && typeof me.visualViewport < "u" ? me.visualViewport : null, Nt = () => [document.documentElement.clientWidth, document.documentElement.clientHeight], Br = function(e) {
  e === void 0 && (e = Lr);
  const {
    wait: t,
    leading: i,
    initialWidth: r = 0,
    initialHeight: n = 0
  } = e, [o, a] = vr(
    /* istanbul ignore next */
    typeof document > "u" ? [r, n] : Nt,
    t,
    i
  ), c = () => a(Nt);
  return pe(me, "resize", c), pe(Sr, "resize", c), pe(me, "orientationchange", c), o;
}, Je = (e, t) => {
  const i = t || Pr;
  let r, n;
  return function() {
    return r && i(arguments, r) ? n : n = e.apply(null, r = arguments);
  };
}, Pr = (e, t) => e[0] === t[0] && e[1] === t[1] && e[2] === t[2] && e[3] === t[3];
class Kt {
  constructor() {
    this.set = void 0, this.get = void 0;
    let t, i;
    this.get = (r) => r === t ? i : void 0, this.set = (r, n) => {
      t = r, i = n;
    };
  }
}
const it = (e) => {
  try {
    return new e();
  } catch {
    const i = {};
    return {
      set(r, n) {
        i[r] = n;
      },
      get(r) {
        return i[r];
      }
    };
  }
}, Hr = (e) => {
  const t = e.length, i = it(e[0]);
  let r, n, o, a;
  const c = t === 1, u = (h) => (r = i.get(h[0])) === void 0 || c ? r : r.get(h[1]), l = (h, d) => (c ? i.set(h[0], d) : (r = i.get(h[0])) === void 0 ? (n = it(e[1]), n.set(h[1], d), i.set(h[0], n)) : r.set(h[1], d), d), s = (h) => {
    for (a = i, o = 0; o < t; o++) if ((a = a.get(h[o])) === void 0) return;
    return a;
  }, f = (h, d) => {
    for (a = i, o = 0; o < t - 1; o++)
      (n = a.get(h[o])) === void 0 && (n = it(e[o + 1]), a.set(h[o], n)), a = n;
    return a.set(h[t - 1], d), d;
  };
  return t < 3 ? {
    g: u,
    s: l
  } : {
    g: s,
    s: f
  };
}, ki = (e, t) => {
  let i;
  const {
    g: r,
    s: n
  } = Hr(e);
  return function() {
    return (i = r(arguments)) === void 0 ? n(arguments, t.apply(null, arguments)) : i;
  };
}, At = /* @__PURE__ */ new WeakMap();
function ji() {
  const e = v.useState(Qr)[1];
  return v.useRef(() => e({})).current;
}
const Qr = {}, Te = v.createElement;
function Or(e) {
  let {
    // Measurement and layout
    positioner: t,
    resizeObserver: i,
    // Grid items
    items: r,
    // Container props
    as: n = "div",
    id: o,
    className: a,
    style: c,
    role: u = "grid",
    tabIndex: l = 0,
    containerRef: s,
    // Item props
    itemAs: f = "div",
    itemStyle: h,
    itemHeightEstimate: d = 300,
    itemKey: g = Rr,
    // Rendering props
    overscanBy: p = 2,
    scrollTop: C,
    isScrolling: w,
    height: z,
    render: x,
    onRender: y
  } = e, L = 0, b;
  const m = ji(), H = Tr(t, i), K = r.length, {
    columnWidth: re,
    columnCount: qe,
    range: ve,
    estimateHeight: gr,
    size: dr,
    shortestColumn: ur
  } = t, Le = dr(), Dt = ur(), _e = [], Tt = u === "list" ? "listitem" : u === "grid" ? "gridcell" : void 0, $e = Ke(y);
  p = z * p;
  const Yt = C + p, et = Dt < Yt && Le < K;
  if (ve(
    // We overscan in both directions because users scroll both ways,
    // though one must admit scrolling down is more common and thus
    // we only overscan by half the downward overscan amount
    Math.max(0, C - p / 2),
    Yt,
    (R, F, Se) => {
      const Z = r[R], tt = g(Z, R), Mt = {
        top: Se,
        left: F,
        width: re,
        writingMode: "horizontal-tb",
        position: "absolute"
      };
      typeof process < "u" && process.env.NODE_ENV !== "production" && Jt(Z, R), _e.push(/* @__PURE__ */ Te(f, {
        key: tt,
        ref: H(R),
        role: Tt,
        style: typeof h == "object" && h !== null ? Object.assign({}, Mt, h) : Mt
      }, Ut(x, R, Z, re))), b === void 0 ? (L = R, b = R) : (L = Math.min(L, R), b = Math.max(b, R));
    }
  ), et) {
    const R = Math.min(K - Le, Math.ceil((C + p - Dt) / d * qe));
    let F = Le;
    const Se = Dr(re);
    for (; F < Le + R; F++) {
      const Z = r[F], tt = g(Z, F);
      typeof process < "u" && process.env.NODE_ENV !== "production" && Jt(Z, F), _e.push(/* @__PURE__ */ Te(f, {
        key: tt,
        ref: H(F),
        role: Tt,
        style: typeof h == "object" ? Object.assign({}, Se, h) : Se
      }, Ut(x, F, Z, re)));
    }
  }
  v.useEffect(() => {
    typeof $e.current == "function" && b !== void 0 && $e.current(L, b, r), Gt = "1";
  }, [L, b, r, $e]), v.useEffect(() => {
    et && m();
  }, [et, t]);
  const Ft = kr(w, gr(K, d));
  return /* @__PURE__ */ Te(n, {
    ref: s,
    key: Gt,
    id: o,
    role: u,
    className: a,
    tabIndex: l,
    style: typeof c == "object" ? jr(Ft, c) : Ft,
    children: _e
  });
}
function Jt(e, t) {
  if (!e)
    throw new Error(`No data was found at index: ${t}

This usually happens when you've mutated or changed the "items" array in a way that makes it shorter than the previous "items" array. Masonic knows nothing about your underlying data and when it caches cell positions, it assumes you aren't mutating the underlying "items".

See https://codesandbox.io/s/masonic-w-react-router-example-2b5f9?file=/src/index.js for an example that gets around this limitations. For advanced implementations, see https://codesandbox.io/s/masonic-w-react-router-and-advanced-config-example-8em42?file=/src/index.js

If this was the result of your removing an item from your "items", see this issue: https://github.com/jaredLunde/masonic/issues/12`);
}
let Gt = "0";
const Ut = /* @__PURE__ */ ki([Kt, {}, WeakMap, Kt], (e, t, i, r) => /* @__PURE__ */ Te(e, {
  index: t,
  data: i,
  width: r
})), kr = /* @__PURE__ */ Je((e, t) => ({
  position: "relative",
  width: "100%",
  maxWidth: "100%",
  height: Math.ceil(t),
  maxHeight: Math.ceil(t),
  willChange: e ? "contents" : void 0,
  pointerEvents: e ? "none" : void 0
})), Ri = (e, t) => e[0] === t[0] && e[1] === t[1], jr = /* @__PURE__ */ Je(
  (e, t) => Object.assign({}, e, t),
  // @ts-expect-error
  Ri
);
function Rr(e, t) {
  return t;
}
const Dr = /* @__PURE__ */ Je((e) => ({
  width: e,
  zIndex: -1e3,
  visibility: "hidden",
  position: "absolute",
  writingMode: "horizontal-tb"
}), (e, t) => e[0] === t[0]), Tr = /* @__PURE__ */ Je(
  (e, t) => (i) => (r) => {
    r !== null && (t && (t.observe(r), At.set(r, i)), e.get(i) === void 0 && e.set(i, r.offsetHeight));
  },
  // @ts-expect-error
  Ri
);
let Di = "undefined", ce = typeof window !== Di ? window : {}, Yr = typeof performance !== Di ? performance : Date, pt = () => Yr.now(), Ti = "AnimationFrame", Xt = "cancel" + Ti, Zt = "request" + Ti, Fe = ce[Zt] && /* @__PURE__ */ ce[Zt].bind(ce), mt = ce[Xt] && /* @__PURE__ */ ce[Xt].bind(ce);
function Fr(e) {
  return clearTimeout(e);
}
if (!Fe || !mt) {
  let e = 0;
  Fe = (t) => {
    let i = pt(), r = Math.max(e + 1e3 / 60, i);
    return setTimeout(() => {
      t(e = r);
    }, r - i);
  }, mt = Fr;
}
const Mr = (e) => {
  mt(e.v || -1);
}, Wr = (e, t) => {
  const i = pt(), r = {}, n = () => {
    pt() - i >= t ? e.call(null) : r.v = Fe(n);
  };
  return r.v = Fe(n), r;
}, Nr = typeof performance < "u" ? performance : Date, Kr = () => Nr.now();
function Yi(e, t = 30, i = !1) {
  const r = Ke(e), n = 1e3 / t, o = v.useRef(0), a = v.useRef(), c = () => a.current && clearTimeout(a.current), u = [t, i, r];
  function l() {
    o.current = 0, c();
  }
  return v.useEffect(() => l, u), v.useCallback(function() {
    const s = arguments, f = Kr(), h = () => {
      o.current = f, c(), r.current.apply(null, s);
    }, d = o.current;
    if (i && d === 0) return h();
    if (f - d > n) {
      if (d > 0) return h();
      o.current = f;
    }
    c(), a.current = setTimeout(() => {
      h(), o.current = 0;
    }, n);
  }, u);
}
function Jr(e, t, i) {
  const r = v.useState(e);
  return [r[0], Yi(r[1], t, i)];
}
const de = typeof window > "u" ? null : window, Vt = () => de.scrollY !== void 0 ? de.scrollY : de.pageYOffset === void 0 ? 0 : de.pageYOffset, Gr = (e = 30) => {
  const t = Jr(typeof window > "u" ? 0 : Vt, e, !0);
  return pe(de, "scroll", () => t[1](Vt())), t[0];
};
function Ur(e, t) {
  e === void 0 && (e = 0), t === void 0 && (t = 12);
  const i = Gr(t), [r, n] = v.useState(!1), o = v.useRef(0);
  return v.useEffect(() => {
    o.current === 1 && n(!0);
    let a = !1;
    const c = Wr(() => {
      a || n(!1);
    }, 40 + 1e3 / t);
    return o.current = 1, () => {
      a = !0, Mr(c);
    };
  }, [t, i]), {
    scrollTop: Math.max(0, i - e),
    isScrolling: r
  };
}
function Fi(e) {
  const {
    scrollTop: t,
    isScrolling: i
  } = Ur(e.offset, e.scrollFps);
  return Or({
    scrollTop: t,
    isScrolling: i,
    positioner: e.positioner,
    resizeObserver: e.resizeObserver,
    items: e.items,
    onRender: e.onRender,
    as: e.as,
    id: e.id,
    className: e.className,
    style: e.style,
    role: e.role,
    tabIndex: e.tabIndex,
    containerRef: e.containerRef,
    itemAs: e.itemAs,
    itemStyle: e.itemStyle,
    itemHeightEstimate: e.itemHeightEstimate,
    itemKey: e.itemKey,
    overscanBy: e.overscanBy,
    height: e.height,
    render: e.render
  });
}
typeof process < "u" && process.env.NODE_ENV !== "production" && (Fi.displayName = "MasonryScroller");
const Xr = B[typeof document < "u" && document.createElement !== void 0 ? "useLayoutEffect" : "useEffect"];
function Zr(e, t) {
  t === void 0 && (t = Vr);
  const [i, r] = v.useState({
    offset: 0,
    width: 0
  });
  return Xr(() => {
    const {
      current: n
    } = e;
    if (n !== null) {
      let o = 0, a = n;
      do
        o += a.offsetTop || 0, a = a.offsetParent;
      while (a);
      (o !== i.offset || n.offsetWidth !== i.width) && r({
        offset: o,
        width: n.offsetWidth
      });
    }
  }, t), i;
}
const Vr = [];
function qr(e, t) {
  let {
    width: i,
    columnWidth: r = 200,
    columnGutter: n = 0,
    rowGutter: o,
    columnCount: a,
    maxColumnCount: c
  } = e;
  t === void 0 && (t = tn);
  const u = () => {
    const [g, p] = en(i, r, n, a, c);
    return _r(p, g, n, o ?? n);
  }, l = v.useRef();
  l.current === void 0 && (l.current = u());
  const s = v.useRef(t), f = [i, r, n, o, a, c], h = v.useRef(f), d = !f.every((g, p) => h.current[p] === g);
  if (typeof process < "u" && process.env.NODE_ENV !== "production" && t.length !== s.current.length)
    throw new Error("usePositioner(): The length of your dependencies array changed.");
  if (d || !t.every((g, p) => s.current[p] === g)) {
    const g = l.current, p = u();
    if (s.current = t, h.current = f, d) {
      const C = g.size();
      for (let w = 0; w < C; w++) {
        const z = g.get(w);
        p.set(w, z !== void 0 ? z.height : 0);
      }
    }
    l.current = p;
  }
  return l.current;
}
const _r = function(e, t, i, r) {
  i === void 0 && (i = 0), r === void 0 && (r = i);
  const n = Er(), o = new Array(e), a = [], c = new Array(e);
  for (let u = 0; u < e; u++)
    o[u] = 0, c[u] = [];
  return {
    columnCount: e,
    columnWidth: t,
    set: function(u, l) {
      l === void 0 && (l = 0);
      let s = 0;
      for (let h = 1; h < o.length; h++)
        o[h] < o[s] && (s = h);
      const f = o[s] || 0;
      o[s] = f + l + r, c[s].push(u), a[u] = {
        left: s * (t + i),
        top: f,
        height: l,
        column: s
      }, n.insert(f, f + l, u);
    },
    get: (u) => a[u],
    // This only updates items in the specific columns that have changed, on and after the
    // specific items that have changed
    update: (u) => {
      const l = new Array(e);
      let s = 0, f = 0;
      for (; s < u.length - 1; s++) {
        const h = u[s], d = a[h];
        d.height = u[++s], n.remove(h), n.insert(d.top, d.top + d.height, h), l[d.column] = l[d.column] === void 0 ? h : Math.min(h, l[d.column]);
      }
      for (s = 0; s < l.length; s++) {
        if (l[s] === void 0) continue;
        const h = c[s], d = $r(h, l[s]), g = c[s][d], p = a[g];
        for (o[s] = p.top + p.height + r, f = d + 1; f < h.length; f++) {
          const C = h[f], w = a[C];
          w.top = o[s], o[s] = w.top + w.height + r, n.remove(C), n.insert(w.top, w.top + w.height, C);
        }
      }
    },
    // Render all cells visible within the viewport range defined.
    range: (u, l, s) => n.search(u, l, (f, h) => s(f, a[f].left, h)),
    estimateHeight: (u, l) => {
      const s = Math.max(0, Math.max.apply(null, o));
      return u === n.size ? s : s + Math.ceil((u - n.size) / e) * l;
    },
    shortestColumn: () => o.length > 1 ? Math.min.apply(null, o) : o[0] || 0,
    size() {
      return n.size;
    },
    all() {
      return a;
    }
  };
}, $r = (e, t) => {
  let i = 0, r = e.length - 1;
  for (; i <= r; ) {
    const n = i + r >>> 1, o = e[n];
    if (o === t) return n;
    o <= t ? i = n + 1 : r = n - 1;
  }
  return -1;
}, en = function(e, t, i, r, n) {
  return e === void 0 && (e = 0), t === void 0 && (t = 0), i === void 0 && (i = 8), r = r || Math.min(Math.floor((e + i) / (t + i)), n || 1 / 0) || 1, [Math.floor((e - i * (r - 1)) / r), r];
}, tn = [];
var $ = [], rn = function() {
  return $.some(function(e) {
    return e.activeTargets.length > 0;
  });
}, nn = function() {
  return $.some(function(e) {
    return e.skippedTargets.length > 0;
  });
}, qt = "ResizeObserver loop completed with undelivered notifications.", on = function() {
  var e;
  typeof ErrorEvent == "function" ? e = new ErrorEvent("error", {
    message: qt
  }) : (e = document.createEvent("Event"), e.initEvent("error", !1, !1), e.message = qt), window.dispatchEvent(e);
}, ye;
(function(e) {
  e.BORDER_BOX = "border-box", e.CONTENT_BOX = "content-box", e.DEVICE_PIXEL_CONTENT_BOX = "device-pixel-content-box";
})(ye || (ye = {}));
var ee = function(e) {
  return Object.freeze(e);
}, an = /* @__PURE__ */ function() {
  function e(t, i) {
    this.inlineSize = t, this.blockSize = i, ee(this);
  }
  return e;
}(), Mi = function() {
  function e(t, i, r, n) {
    return this.x = t, this.y = i, this.width = r, this.height = n, this.top = this.y, this.left = this.x, this.bottom = this.top + this.height, this.right = this.left + this.width, ee(this);
  }
  return e.prototype.toJSON = function() {
    var t = this, i = t.x, r = t.y, n = t.top, o = t.right, a = t.bottom, c = t.left, u = t.width, l = t.height;
    return { x: i, y: r, top: n, right: o, bottom: a, left: c, width: u, height: l };
  }, e.fromRect = function(t) {
    return new e(t.x, t.y, t.width, t.height);
  }, e;
}(), Pt = function(e) {
  return e instanceof SVGElement && "getBBox" in e;
}, Wi = function(e) {
  if (Pt(e)) {
    var t = e.getBBox(), i = t.width, r = t.height;
    return !i && !r;
  }
  var n = e, o = n.offsetWidth, a = n.offsetHeight;
  return !(o || a || e.getClientRects().length);
}, _t = function(e) {
  var t;
  if (e instanceof Element)
    return !0;
  var i = (t = e == null ? void 0 : e.ownerDocument) === null || t === void 0 ? void 0 : t.defaultView;
  return !!(i && e instanceof i.Element);
}, cn = function(e) {
  switch (e.tagName) {
    case "INPUT":
      if (e.type !== "image")
        break;
    case "VIDEO":
    case "AUDIO":
    case "EMBED":
    case "OBJECT":
    case "CANVAS":
    case "IFRAME":
    case "IMG":
      return !0;
  }
  return !1;
}, Ce = typeof window < "u" ? window : {}, Qe = /* @__PURE__ */ new WeakMap(), $t = /auto|scroll/, sn = /^tb|vertical/, ln = /msie|trident/i.test(Ce.navigator && Ce.navigator.userAgent), T = function(e) {
  return parseFloat(e || "0");
}, se = function(e, t, i) {
  return e === void 0 && (e = 0), t === void 0 && (t = 0), i === void 0 && (i = !1), new an((i ? t : e) || 0, (i ? e : t) || 0);
}, ei = ee({
  devicePixelContentBoxSize: se(),
  borderBoxSize: se(),
  contentBoxSize: se(),
  contentRect: new Mi(0, 0, 0, 0)
}), Ni = function(e, t) {
  if (t === void 0 && (t = !1), Qe.has(e) && !t)
    return Qe.get(e);
  if (Wi(e))
    return Qe.set(e, ei), ei;
  var i = getComputedStyle(e), r = Pt(e) && e.ownerSVGElement && e.getBBox(), n = !ln && i.boxSizing === "border-box", o = sn.test(i.writingMode || ""), a = !r && $t.test(i.overflowY || ""), c = !r && $t.test(i.overflowX || ""), u = r ? 0 : T(i.paddingTop), l = r ? 0 : T(i.paddingRight), s = r ? 0 : T(i.paddingBottom), f = r ? 0 : T(i.paddingLeft), h = r ? 0 : T(i.borderTopWidth), d = r ? 0 : T(i.borderRightWidth), g = r ? 0 : T(i.borderBottomWidth), p = r ? 0 : T(i.borderLeftWidth), C = f + l, w = u + s, z = p + d, x = h + g, y = c ? e.offsetHeight - x - e.clientHeight : 0, L = a ? e.offsetWidth - z - e.clientWidth : 0, b = n ? C + z : 0, m = n ? w + x : 0, H = r ? r.width : T(i.width) - b - L, K = r ? r.height : T(i.height) - m - y, re = H + C + L + z, qe = K + w + y + x, ve = ee({
    devicePixelContentBoxSize: se(Math.round(H * devicePixelRatio), Math.round(K * devicePixelRatio), o),
    borderBoxSize: se(re, qe, o),
    contentBoxSize: se(H, K, o),
    contentRect: new Mi(f, u, H, K)
  });
  return Qe.set(e, ve), ve;
}, Ki = function(e, t, i) {
  var r = Ni(e, i), n = r.borderBoxSize, o = r.contentBoxSize, a = r.devicePixelContentBoxSize;
  switch (t) {
    case ye.DEVICE_PIXEL_CONTENT_BOX:
      return a;
    case ye.BORDER_BOX:
      return n;
    default:
      return o;
  }
}, hn = /* @__PURE__ */ function() {
  function e(t) {
    var i = Ni(t);
    this.target = t, this.contentRect = i.contentRect, this.borderBoxSize = ee([i.borderBoxSize]), this.contentBoxSize = ee([i.contentBoxSize]), this.devicePixelContentBoxSize = ee([i.devicePixelContentBoxSize]);
  }
  return e;
}(), Ji = function(e) {
  if (Wi(e))
    return 1 / 0;
  for (var t = 0, i = e.parentNode; i; )
    t += 1, i = i.parentNode;
  return t;
}, gn = function() {
  var e = 1 / 0, t = [];
  $.forEach(function(a) {
    if (a.activeTargets.length !== 0) {
      var c = [];
      a.activeTargets.forEach(function(l) {
        var s = new hn(l.target), f = Ji(l.target);
        c.push(s), l.lastReportedSize = Ki(l.target, l.observedBox), f < e && (e = f);
      }), t.push(function() {
        a.callback.call(a.observer, c, a.observer);
      }), a.activeTargets.splice(0, a.activeTargets.length);
    }
  });
  for (var i = 0, r = t; i < r.length; i++) {
    var n = r[i];
    n();
  }
  return e;
}, ti = function(e) {
  $.forEach(function(i) {
    i.activeTargets.splice(0, i.activeTargets.length), i.skippedTargets.splice(0, i.skippedTargets.length), i.observationTargets.forEach(function(n) {
      n.isActive() && (Ji(n.target) > e ? i.activeTargets.push(n) : i.skippedTargets.push(n));
    });
  });
}, dn = function() {
  var e = 0;
  for (ti(e); rn(); )
    e = gn(), ti(e);
  return nn() && on(), e > 0;
}, rt, Gi = [], un = function() {
  return Gi.splice(0).forEach(function(e) {
    return e();
  });
}, fn = function(e) {
  if (!rt) {
    var t = 0, i = document.createTextNode(""), r = { characterData: !0 };
    new MutationObserver(function() {
      return un();
    }).observe(i, r), rt = function() {
      i.textContent = "".concat(t ? t-- : t++);
    };
  }
  Gi.push(e), rt();
}, An = function(e) {
  fn(function() {
    requestAnimationFrame(e);
  });
}, Ye = 0, pn = function() {
  return !!Ye;
}, mn = 250, Cn = { attributes: !0, characterData: !0, childList: !0, subtree: !0 }, ii = [
  "resize",
  "load",
  "transitionend",
  "animationend",
  "animationstart",
  "animationiteration",
  "keyup",
  "keydown",
  "mouseup",
  "mousedown",
  "mouseover",
  "mouseout",
  "blur",
  "focus"
], ri = function(e) {
  return e === void 0 && (e = 0), Date.now() + e;
}, nt = !1, xn = function() {
  function e() {
    var t = this;
    this.stopped = !0, this.listener = function() {
      return t.schedule();
    };
  }
  return e.prototype.run = function(t) {
    var i = this;
    if (t === void 0 && (t = mn), !nt) {
      nt = !0;
      var r = ri(t);
      An(function() {
        var n = !1;
        try {
          n = dn();
        } finally {
          if (nt = !1, t = r - ri(), !pn())
            return;
          n ? i.run(1e3) : t > 0 ? i.run(t) : i.start();
        }
      });
    }
  }, e.prototype.schedule = function() {
    this.stop(), this.run();
  }, e.prototype.observe = function() {
    var t = this, i = function() {
      return t.observer && t.observer.observe(document.body, Cn);
    };
    document.body ? i() : Ce.addEventListener("DOMContentLoaded", i);
  }, e.prototype.start = function() {
    var t = this;
    this.stopped && (this.stopped = !1, this.observer = new MutationObserver(this.listener), this.observe(), ii.forEach(function(i) {
      return Ce.addEventListener(i, t.listener, !0);
    }));
  }, e.prototype.stop = function() {
    var t = this;
    this.stopped || (this.observer && this.observer.disconnect(), ii.forEach(function(i) {
      return Ce.removeEventListener(i, t.listener, !0);
    }), this.stopped = !0);
  }, e;
}(), Ct = new xn(), ni = function(e) {
  !Ye && e > 0 && Ct.start(), Ye += e, !Ye && Ct.stop();
}, wn = function(e) {
  return !Pt(e) && !cn(e) && getComputedStyle(e).display === "inline";
}, yn = function() {
  function e(t, i) {
    this.target = t, this.observedBox = i || ye.CONTENT_BOX, this.lastReportedSize = {
      inlineSize: 0,
      blockSize: 0
    };
  }
  return e.prototype.isActive = function() {
    var t = Ki(this.target, this.observedBox, !0);
    return wn(this.target) && (this.lastReportedSize = t), this.lastReportedSize.inlineSize !== t.inlineSize || this.lastReportedSize.blockSize !== t.blockSize;
  }, e;
}(), bn = /* @__PURE__ */ function() {
  function e(t, i) {
    this.activeTargets = [], this.skippedTargets = [], this.observationTargets = [], this.observer = t, this.callback = i;
  }
  return e;
}(), Oe = /* @__PURE__ */ new WeakMap(), oi = function(e, t) {
  for (var i = 0; i < e.length; i += 1)
    if (e[i].target === t)
      return i;
  return -1;
}, ke = function() {
  function e() {
  }
  return e.connect = function(t, i) {
    var r = new bn(t, i);
    Oe.set(t, r);
  }, e.observe = function(t, i, r) {
    var n = Oe.get(t), o = n.observationTargets.length === 0;
    oi(n.observationTargets, i) < 0 && (o && $.push(n), n.observationTargets.push(new yn(i, r && r.box)), ni(1), Ct.schedule());
  }, e.unobserve = function(t, i) {
    var r = Oe.get(t), n = oi(r.observationTargets, i), o = r.observationTargets.length === 1;
    n >= 0 && (o && $.splice($.indexOf(r), 1), r.observationTargets.splice(n, 1), ni(-1));
  }, e.disconnect = function(t) {
    var i = this, r = Oe.get(t);
    r.observationTargets.slice().forEach(function(n) {
      return i.unobserve(t, n.target);
    }), r.activeTargets.splice(0, r.activeTargets.length);
  }, e;
}(), zn = function() {
  function e(t) {
    if (arguments.length === 0)
      throw new TypeError("Failed to construct 'ResizeObserver': 1 argument required, but only 0 present.");
    if (typeof t != "function")
      throw new TypeError("Failed to construct 'ResizeObserver': The callback provided as parameter 1 is not a function.");
    ke.connect(this, t);
  }
  return e.prototype.observe = function(t, i) {
    if (arguments.length === 0)
      throw new TypeError("Failed to execute 'observe' on 'ResizeObserver': 1 argument required, but only 0 present.");
    if (!_t(t))
      throw new TypeError("Failed to execute 'observe' on 'ResizeObserver': parameter 1 is not of type 'Element");
    ke.observe(this, t, i);
  }, e.prototype.unobserve = function(t) {
    if (arguments.length === 0)
      throw new TypeError("Failed to execute 'unobserve' on 'ResizeObserver': 1 argument required, but only 0 present.");
    if (!_t(t))
      throw new TypeError("Failed to execute 'unobserve' on 'ResizeObserver': parameter 1 is not of type 'Element");
    ke.unobserve(this, t);
  }, e.prototype.disconnect = function() {
    ke.disconnect(this);
  }, e.toString = function() {
    return "function ResizeObserver () { [polyfill code] }";
  }, e;
}(), ai = function(t) {
  var i = [], r = null, n = function() {
    for (var a = arguments.length, c = new Array(a), u = 0; u < a; u++)
      c[u] = arguments[u];
    i = c, !r && (r = requestAnimationFrame(function() {
      r = null, t.apply(void 0, i);
    }));
  };
  return n.cancel = function() {
    r && (cancelAnimationFrame(r), r = null);
  }, n;
};
const En = typeof window < "u" && "ResizeObserver" in window ? window.ResizeObserver : zn;
function In(e) {
  const t = ji(), i = Ln(e, t);
  function r() {
    return i.disconnect();
  }
  return v.useEffect(() => r, [i]), i;
}
function vn(e) {
  e.cancel();
}
const Ln = /* @__PURE__ */ ki(
  [WeakMap],
  // TODO: figure out a way to test this
  /* istanbul ignore next */
  (e, t) => {
    const i = [], r = ai(() => {
      i.length > 0 && (e.update(i), t(i)), i.length = 0;
    }), n = (l) => {
      const s = l.offsetHeight;
      if (s > 0) {
        const f = At.get(l);
        if (f !== void 0) {
          const h = e.get(f);
          h !== void 0 && s !== h.height && i.push(f, s);
        }
      }
      r();
    }, o = /* @__PURE__ */ new Map(), a = (l) => {
      let s = 0;
      for (; s < l.length; s++) {
        const f = l[s], h = At.get(f.target);
        if (h === void 0) continue;
        let d = o.get(h);
        d || (d = ai(n), o.set(h, d)), d(f.target);
      }
    }, c = new En(a), u = c.disconnect.bind(c);
    return c.disconnect = () => {
      u(), o.forEach(vn);
    }, c;
  }
);
function Sn(e, t) {
  var i;
  const {
    align: r = "top",
    element: n = typeof window < "u" && window,
    offset: o = 0,
    height: a = typeof window < "u" ? window.innerHeight : 0
  } = t, c = Ke({
    positioner: e,
    element: n,
    align: r,
    offset: o,
    height: a
  }), u = v.useRef(() => {
    const d = c.current.element;
    return d && "current" in d ? d.current : d;
  }).current, [l, s] = v.useReducer((d, g) => {
    const p = {
      position: d.position,
      index: d.index,
      prevTop: d.prevTop
    };
    if (g.type === "scrollToIndex") {
      var C;
      return {
        position: c.current.positioner.get((C = g.value) !== null && C !== void 0 ? C : -1),
        index: g.value,
        prevTop: void 0
      };
    } else if (g.type === "setPosition")
      p.position = g.value;
    else if (g.type === "setPrevTop")
      p.prevTop = g.value;
    else if (g.type === "reset")
      return ci;
    return p;
  }, ci), f = Yi(s, 15);
  pe(u(), "scroll", () => {
    if (!l.position && l.index) {
      const d = c.current.positioner.get(l.index);
      d && s({
        type: "setPosition",
        value: d
      });
    }
  });
  const h = l.index !== void 0 && ((i = c.current.positioner.get(l.index)) === null || i === void 0 ? void 0 : i.top);
  return v.useEffect(() => {
    const d = u();
    if (!d) return;
    const {
      height: g,
      align: p,
      offset: C,
      positioner: w
    } = c.current;
    if (l.position) {
      let z = l.position.top;
      p === "bottom" ? z = z - g + l.position.height : p === "center" && (z -= (g - l.position.height) / 2), d.scrollTo(0, Math.max(0, z += C));
      let x = !1;
      const y = setTimeout(() => !x && s({
        type: "reset"
      }), 400);
      return () => {
        x = !0, clearTimeout(y);
      };
    } else if (l.index !== void 0) {
      let z = w.shortestColumn() / w.size() * l.index;
      l.prevTop && (z = Math.max(z, l.prevTop + g)), d.scrollTo(0, z), f({
        type: "setPrevTop",
        value: z
      });
    }
  }, [h, l, c, u, f]), v.useRef((d) => {
    s({
      type: "scrollToIndex",
      value: d
    });
  }).current;
}
const ci = {
  index: void 0,
  position: void 0,
  prevTop: void 0
}, Bn = v.createElement;
function Ui(e) {
  const t = v.useRef(null), i = Br({
    initialWidth: e.ssrWidth,
    initialHeight: e.ssrHeight
  }), r = Zr(t, i), n = Object.assign({
    offset: r.offset,
    width: r.width || i[0],
    height: i[1],
    containerRef: t
  }, e);
  n.positioner = qr(n), n.resizeObserver = In(n.positioner);
  const o = Sn(n.positioner, {
    height: n.height,
    offset: r.offset,
    align: typeof e.scrollToIndex == "object" ? e.scrollToIndex.align : void 0
  }), a = e.scrollToIndex && (typeof e.scrollToIndex == "number" ? e.scrollToIndex : e.scrollToIndex.index);
  return v.useEffect(() => {
    a !== void 0 && o(a);
  }, [a, o]), Bn(Fi, n);
}
typeof process < "u" && process.env.NODE_ENV !== "production" && (Ui.displayName = "Masonry");
const N = 290, Xi = 16, Pn = 16, Zi = {
  titleFont: '"Noto Serif SC", STSong, SimSun, serif',
  descriptionFont: '"Noto Sans SC", "Microsoft YaHei", sans-serif',
  titleEnglishFont: "Georgia",
  titleChineseFont: '"Noto Serif SC"',
  descriptionEnglishFont: "Inter",
  descriptionChineseFont: '"Noto Sans SC"'
}, si = {
  enabled: !0,
  grayscale: 0.6,
  sepia: 0.3,
  overlayColor: "rgba(74, 128, 118, 0.26)",
  overlayOpacity: 1,
  textColor: "#1d3444",
  lineColor: "rgba(29, 52, 68, 0.46)",
  transitionDuration: 400
};
function Hn(e, t = Xi, i = 3) {
  const r = Math.floor((e + t) / (N + t)), n = Math.max(i, r), o = N * n + t * Math.max(0, n - 1), a = Math.max(0, Math.floor((e - o) / 2));
  return { columns: n, gridWidth: o, sidePadding: a };
}
function Qn(e) {
  const t = e.replace(/[\s《》「」『』，。！？、；：“”‘’（）()【】\-—·.]/g, "");
  return t.length > 0 && /^[\u3400-\u9fff]+$/.test(t);
}
function On(e) {
  return {
    ...si,
    ...e,
    enabled: (e == null ? void 0 : e.enabled) ?? si.enabled
  };
}
function ne(e) {
  return JSON.parse(JSON.stringify(e));
}
function D(e, t, i) {
  return Math.min(i, Math.max(t, e));
}
function V(e, t = 4) {
  return Math.round(e / t) * t;
}
function kn({
  element: e,
  article: t,
  selected: i = !1,
  editorMode: r = !1,
  filter: n,
  onPointerDown: o,
  onClick: a
}) {
  const c = e.source === "dynamic" ? t.imageUrl : e.staticUrl;
  if (!c && !r) return null;
  const u = {
    position: "absolute",
    left: e.x,
    top: e.y,
    width: e.width,
    height: e.height,
    zIndex: e.zIndex ?? 1,
    clipPath: e.shape === "trapezoid" ? e.clipPath : void 0,
    overflow: "hidden",
    opacity: e.opacity,
    cursor: r ? "move" : void 0,
    outline: i ? "1px dashed rgba(42,80,128,.85)" : void 0,
    outlineOffset: 2,
    background: r && !c ? "rgba(42,80,128,.08)" : void 0,
    filter: n,
    transition: n ? "filter 400ms ease" : void 0
  }, l = {
    width: "100%",
    height: "100%",
    objectFit: e.objectFit ?? "cover",
    objectPosition: e.objectPosition,
    display: "block",
    clipPath: e.shape === "trapezoid" ? e.clipPath : void 0
  };
  return /* @__PURE__ */ A(
    "div",
    {
      className: "cm-image",
      "data-testid": `cm-image-${e.id}`,
      style: u,
      onPointerDown: o,
      onClick: (s) => {
        r && s.stopPropagation(), a == null || a();
      },
      children: c ? /* @__PURE__ */ A("img", { src: c, alt: t.title, style: l, loading: "lazy" }) : /* @__PURE__ */ A("span", { className: "cm-image-placeholder", children: e.source === "dynamic" ? "首图" : "背景图" })
    }
  );
}
function jn({
  element: e,
  selected: t = !1,
  editorMode: i = !1,
  colorOverride: r,
  filter: n,
  onPointerDown: o,
  onClick: a
}) {
  const c = {
    position: "absolute",
    left: e.x,
    top: e.y,
    width: e.direction === "horizontal" ? e.length : e.thickness,
    height: e.direction === "horizontal" ? e.thickness : e.length,
    background: r ?? e.color,
    zIndex: e.zIndex ?? 10,
    filter: n,
    cursor: i ? "move" : void 0,
    outline: t ? "1px dashed rgba(184,134,11,.9)" : void 0,
    outlineOffset: 3
  }, u = ["cm-line", i ? "cm-line-editor" : "", t ? "cm-line-selected" : ""].filter(Boolean).join(" ");
  return /* @__PURE__ */ A(
    "div",
    {
      className: u,
      "data-testid": `cm-line-${e.id}`,
      style: c,
      onPointerDown: o,
      onClick: (l) => {
        i && l.stopPropagation(), a == null || a();
      },
      children: i ? /* @__PURE__ */ A("span", { className: "cm-line-hit-area", "aria-hidden": "true" }) : null
    }
  );
}
function Vi(e) {
  const t = e.lineHeight ?? 1.6;
  return {
    height: Math.ceil(e.fontSize * t * Math.max(1, e.maxLines))
  };
}
function qi(e, t, i) {
  const r = t.letterSpacing ?? 0, n = Math.max(1, t.fontSize + r), o = Math.max(1, Math.floor(t.height / n)), a = Math.max(1, t.maxLines), c = o * a, u = e.length > c ? `${e.slice(0, Math.max(1, c - 1))}…` : e, l = Math.max(t.fontSize, t.fontSize * i), s = Math.max(0, (l - t.fontSize) / 2), f = Math.ceil(t.fontSize + (a - 1) * l + s);
  return {
    text: u,
    width: f,
    xOffset: t.blockAlign === "end" ? 0 : t.width - f,
    writingMode: t.blockAlign === "end" ? "vertical-lr" : "vertical-rl"
  };
}
function Rn({
  element: e,
  article: t,
  fontConfig: i,
  colorOverride: r,
  selected: n = !1,
  editorMode: o = !1,
  onPointerDown: a,
  onClick: c
}) {
  const u = e.content ?? (e.role === "title" ? t.title : e.role === "description" ? t.description ?? "" : ""), l = e.lineHeight ?? 1.6, s = e.role === "description" ? i.descriptionFont : i.titleFont, f = e.direction === "vertical" ? qi(u, e, l) : null, h = e.direction === "horizontal" ? Vi(e) : null, d = (f == null ? void 0 : f.text) ?? u, g = e.direction === "horizontal" && e.blockAlign === "end", p = {
    position: "absolute",
    left: e.x + ((f == null ? void 0 : f.xOffset) ?? 0),
    top: e.y,
    width: (f == null ? void 0 : f.width) ?? e.width,
    height: f ? e.height : h == null ? void 0 : h.height,
    color: r ?? e.color,
    fontFamily: s,
    fontSize: e.fontSize,
    fontWeight: e.fontWeight ?? "normal",
    letterSpacing: e.letterSpacing,
    lineHeight: l,
    textAlign: e.textAlign ?? "left",
    zIndex: 20,
    cursor: o ? "move" : void 0,
    outline: n ? "1px dashed rgba(160,48,32,.8)" : void 0,
    outlineOffset: 2
  };
  e.direction === "vertical" ? (p.writingMode = (f == null ? void 0 : f.writingMode) ?? "vertical-rl", p.textOrientation = "mixed", p.overflow = "hidden", p.whiteSpace = "normal") : (p.display = "flex", p.flexDirection = "column", p.justifyContent = g ? "flex-end" : "flex-start", p.overflow = "hidden");
  const C = e.direction === "horizontal" ? {
    display: "-webkit-box",
    WebkitLineClamp: e.maxLines,
    WebkitBoxOrient: "vertical",
    overflow: "hidden"
  } : void 0;
  return /* @__PURE__ */ A(
    "div",
    {
      className: `cm-text cm-text-${e.role}`,
      "data-testid": `cm-text-${e.id}`,
      style: p,
      onPointerDown: a,
      onClick: (w) => {
        o && w.stopPropagation(), c == null || c();
      },
      children: /* @__PURE__ */ A("span", { style: C, children: d || (o ? `${e.role === "title" ? "标题" : "摘要"}占位符` : null) })
    }
  );
}
function li(e) {
  return e.type === "image" ? e.zIndex ?? 1 : e.type === "line" ? e.zIndex ?? 10 : 20;
}
function _i({
  article: e,
  template: t,
  fontConfig: i,
  colorConfig: r,
  className: n,
  style: o,
  onClick: a,
  editorMode: c = !1,
  selectedElementId: u,
  onSelectElement: l,
  onElementPointerDown: s
}) {
  const f = {
    ...Zi,
    ...i
  }, h = On(r), d = h.enabled ? `grayscale(${h.grayscale}) sepia(${h.sepia})` : void 0, g = {
    width: t.width,
    height: t.height,
    position: "relative",
    overflow: "hidden",
    // borderRadius is controlled by CSS (.cm-card) — no inline override
    background: t.backgroundColor ?? "#f5f0e8",
    // boxShadow is controlled by CSS (.cm-card / .cm-card:hover) — no inline override
    transition: "transform 220ms ease, box-shadow 220ms ease",
    cursor: a ? "pointer" : void 0,
    ...o
  }, p = [...t.elements].sort((C, w) => li(C) - li(w));
  return /* @__PURE__ */ E(
    "article",
    {
      className: `cm-card ${n ?? ""}`,
      "data-template-id": t.id,
      "data-article-id": e.id,
      "data-testid": "cm-card",
      style: g,
      onClick: () => a == null ? void 0 : a(e),
      children: [
        p.map((C) => {
          const z = {
            selected: u === C.id,
            editorMode: c,
            onClick: () => l == null ? void 0 : l(C.id),
            onPointerDown: (x) => s == null ? void 0 : s(C.id, x)
          };
          return C.type === "image" ? /* @__PURE__ */ A(
            kn,
            {
              element: C,
              article: e,
              filter: c ? void 0 : d,
              ...z
            },
            C.id
          ) : C.type === "line" ? /* @__PURE__ */ A(
            jn,
            {
              element: C,
              colorOverride: h.enabled ? h.lineColor : void 0,
              filter: c ? void 0 : d,
              ...z
            },
            C.id
          ) : /* @__PURE__ */ A(
            Rn,
            {
              element: C,
              article: e,
              fontConfig: f,
              colorOverride: h.enabled ? h.textColor : void 0,
              ...z
            },
            C.id
          );
        }),
        h.enabled && !c ? /* @__PURE__ */ A(
          "div",
          {
            className: "cm-card-color-overlay",
            "data-testid": "cm-card-color-overlay",
            style: {
              position: "absolute",
              inset: 0,
              zIndex: 15,
              pointerEvents: "none",
              background: h.overlayColor,
              // opacity is controlled by CSS (.cm-card-color-overlay / .cm-card:hover .cm-card-color-overlay)
              // Using a CSS custom property so the CSS rule can override on hover
              "--cm-overlay-opacity": h.overlayOpacity,
              transition: `opacity ${h.transitionDuration}ms ease`
            }
          }
        ) : null
      ]
    }
  );
}
const Dn = [
  {
    id: "curated-shanshui-blank",
    name: "山水留白",
    version: 1,
    width: 290,
    height: 420,
    backgroundColor: "#fbf8f1",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/shan-shui.jpg",
        prompt: "中国风笔记卡片背景，淡墨山水集中在左下与底部，远山虚化，右上大面积留白，宣纸米白底，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 420,
        objectFit: "cover",
        objectPosition: "50% 50%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 136,
        y: 78,
        width: 120,
        height: 72,
        fontSize: 22,
        color: "#20333a",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "start"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 136,
        y: 142,
        width: 122,
        height: 82,
        fontSize: 13,
        color: "rgba(32, 51, 58, 0.66)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 5,
        blockAlign: "start"
      },
      {
        id: "line-1",
        type: "line",
        x: 136,
        y: 286,
        length: 64,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(32, 51, 58, 0.3)",
        zIndex: 10
      },
      {
        id: "seal",
        type: "image",
        role: "stamp",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/seal-kongshengmiaoyou.png",
        prompt: "朱文篆刻印章素材，四字为「空生妙有」，传统四字印章读法为右上空、右下生、左上妙、左下有，小篆风格，红印泥质感。",
        x: 232,
        y: 340,
        width: 30,
        height: 30,
        objectFit: "contain",
        objectPosition: "50% 50%",
        opacity: 0.9,
        shape: "rectangle",
        zIndex: 24
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "山水",
        "淡墨灰"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 11,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 45,
          charactersPerLine: 9,
          lineCount: 5,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-taohua-note",
    name: "桃花疏影",
    version: 1,
    width: 290,
    height: 420,
    backgroundColor: "#fcf8f4",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/tao-hua.jpg",
        prompt: "中国风笔记卡片背景，一枝水墨桃花从左下伸展，浅桃粉与淡墨，右上留白，宣纸质感，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 420,
        objectFit: "cover",
        objectPosition: "50% 50%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 142,
        y: 72,
        width: 118,
        height: 72,
        fontSize: 22,
        color: "#3a2522",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "start"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 142,
        y: 142,
        width: 116,
        height: 82,
        fontSize: 13,
        color: "rgba(58, 37, 34, 0.64)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 5,
        blockAlign: "start"
      },
      {
        id: "line-1",
        type: "line",
        x: 142,
        y: 304,
        length: 54,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(154, 70, 64, 0.34)",
        zIndex: 10
      },
      {
        id: "seal",
        type: "image",
        role: "stamp",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/seal-kongshengmiaoyou.png",
        prompt: "朱文篆刻印章素材，四字为「空生妙有」，传统四字印章读法为右上空、右下生、左上妙、左下有，小篆风格，红印泥质感。",
        x: 25.14276123046875,
        y: 23.142791748046875,
        width: 30,
        height: 30,
        objectFit: "contain",
        objectPosition: "50% 50%",
        opacity: 0.9,
        shape: "rectangle",
        zIndex: 24
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "桃花",
        "浅粉"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 10,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 40,
          charactersPerLine: 8,
          lineCount: 5,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-cuiniao-vertical",
    name: "翠鸟荷笺",
    version: 1,
    width: 290,
    height: 420,
    backgroundColor: "#fbf8f0",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/cui-niao.jpg",
        prompt: "中国风笔记卡片背景，水墨化翠鸟与荷叶莲蓬位于左下，青灰低饱和，右侧留白，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 420,
        objectFit: "cover",
        objectPosition: "50% 50%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 200,
        y: 64,
        width: 58,
        height: 168,
        fontSize: 22,
        color: "#183244",
        direction: "vertical",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 1,
        blockAlign: "start"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 134,
        y: 260,
        width: 124,
        height: 74,
        fontSize: 13,
        color: "rgba(24, 50, 68, 0.64)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 3,
        blockAlign: "start"
      },
      {
        id: "line-1",
        type: "line",
        x: 266.5714111328125,
        y: 265.5,
        length: 58,
        direction: "vertical",
        thickness: 0.5,
        color: "rgba(24, 50, 68, 0.3)",
        zIndex: 10
      },
      {
        id: "seal",
        type: "image",
        role: "stamp",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/seal-kongshengmiaoyou.png",
        prompt: "朱文篆刻印章素材，四字为「空生妙有」，传统四字印章读法为右上空、右下生、左上妙、左下有，小篆风格，红印泥质感。",
        x: 228,
        y: 15.142791748046875,
        width: 30,
        height: 30,
        objectFit: "contain",
        objectPosition: "50% 50%",
        opacity: 0.9,
        shape: "rectangle",
        zIndex: 24
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "翠鸟",
        "荷叶",
        "青绿"
      ],
      requiresImage: !1,
      preferVerticalText: !0,
      maxTitleLength: 7,
      weight: 12,
      textCapacity: {
        title: {
          direction: "vertical",
          maxCharacters: 7,
          charactersPerColumn: 7,
          columnCount: 1,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 27,
          charactersPerLine: 9,
          lineCount: 3,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-shrimp-water",
    name: "水虾清纹",
    version: 1,
    width: 290,
    height: 390,
    backgroundColor: "#fbf9f4",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/shui-mo-xia.jpg",
        prompt: "中国风笔记卡片背景，三至五只水墨写意虾与极淡水纹集中一角，大片留白，宣纸底，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 390,
        objectFit: "cover",
        objectPosition: "50% 50%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 140,
        y: 80,
        width: 118,
        height: 72,
        fontSize: 22,
        color: "#243033",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "start"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 142,
        y: 140,
        width: 116,
        height: 82,
        fontSize: 13,
        color: "rgba(36, 48, 51, 0.64)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 5,
        blockAlign: "start"
      },
      {
        id: "line-1",
        type: "line",
        x: 142,
        y: 294,
        length: 46,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(36, 48, 51, 0.26)",
        zIndex: 10
      },
      {
        id: "seal",
        type: "image",
        role: "stamp",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/seal-kongshengmiaoyou.png",
        prompt: "朱文篆刻印章素材，四字为「空生妙有」，传统四字印章读法为右上空、右下生、左上妙、左下有，小篆风格，红印泥质感。",
        x: 228,
        y: 323.71429443359375,
        width: 30,
        height: 30,
        objectFit: "contain",
        objectPosition: "50% 50%",
        opacity: 0.9,
        shape: "rectangle",
        zIndex: 24
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "水墨虾",
        "水纹"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 10,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 40,
          charactersPerLine: 8,
          lineCount: 5,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-bamboo-shadow",
    name: "竹影素笺",
    version: 1,
    width: 290,
    height: 360,
    backgroundColor: "#fdfaf4",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/zhu-ying.jpg",
        prompt: "中国风极简卡片背景，米白宣纸纸面，柔和竹影与淡水纹投射，现代东方留白，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 360,
        objectFit: "cover",
        objectPosition: "50% 50%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 132.5,
        y: 31.142822265625,
        width: 132,
        height: 240,
        fontSize: 22,
        color: "#25342f",
        direction: "vertical",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 1,
        blockAlign: "start",
        textAlign: "left"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 81,
        y: 31.142822265625,
        width: 130,
        height: 264,
        fontSize: 13,
        color: "rgba(37, 52, 47, 0.62)",
        direction: "vertical",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 4,
        blockAlign: "start"
      },
      {
        id: "seal",
        type: "image",
        role: "stamp",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/seal-kongshengmiaoyou.png",
        prompt: "朱文篆刻印章素材，四字为「空生妙有」，传统四字印章读法为右上空、右下生、左上妙、左下有，小篆风格，红印泥质感。",
        x: 236.5,
        y: 314,
        width: 30,
        height: 30,
        objectFit: "contain",
        objectPosition: "50% 50%",
        opacity: 0.9,
        shape: "rectangle",
        zIndex: 24
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "竹影",
        "光影",
        "青灰"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 9,
      textCapacity: {
        title: {
          direction: "vertical",
          maxCharacters: 10,
          charactersPerColumn: 10,
          columnCount: 1,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "vertical",
          maxCharacters: 80,
          charactersPerColumn: 20,
          columnCount: 4,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-wide-mountain-quote",
    name: "远山引句",
    version: 1,
    width: 290,
    height: 250,
    backgroundColor: "#fbf8f1",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/wide-mountain.jpg",
        prompt: "横版中国风背景，左侧淡墨远山与水面，右侧干净留白，宣纸质感，非写实，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 250,
        objectFit: "cover",
        objectPosition: "34% 50%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "quote",
        type: "text",
        role: "decoration",
        content: "“",
        x: 26,
        y: 26,
        width: 78,
        height: 88,
        fontSize: 78,
        color: "rgba(32, 51, 58, 0.11)",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 0,
        lineHeight: 1,
        maxLines: 1,
        textAlign: "left",
        blockAlign: "start"
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 138,
        y: 48,
        width: 118,
        height: 72,
        fontSize: 22,
        color: "#20333a",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "start",
        textAlign: "left"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 138,
        y: 112,
        width: 120,
        height: 82,
        fontSize: 13,
        color: "rgba(32, 51, 58, 0.66)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 3,
        blockAlign: "start"
      },
      {
        id: "line-1",
        type: "line",
        x: 138,
        y: 214,
        length: 46,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(32, 51, 58, 0.26)",
        zIndex: 10
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "横版",
        "山水",
        "引号"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 12,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 27,
          charactersPerLine: 9,
          lineCount: 3,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-wide-lotus-right",
    name: "右荷短札",
    version: 1,
    width: 290,
    height: 260,
    backgroundColor: "#fbf7ef",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/wide-lotus.jpg",
        prompt: "横版中国风背景，淡彩荷花荷叶在右侧，左侧留白给文字，米白宣纸，浅青绿，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 260,
        objectFit: "cover",
        objectPosition: "68% 58%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 28,
        y: 36,
        width: 122,
        height: 72,
        fontSize: 22,
        color: "#21332d",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "start"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 28,
        y: 96,
        width: 126,
        height: 82,
        fontSize: 13,
        color: "rgba(33, 51, 45, 0.65)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 4,
        blockAlign: "start"
      },
      {
        id: "line-1",
        type: "line",
        x: 28,
        y: 218,
        length: 76,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(33, 51, 45, 0.24)",
        zIndex: 10
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "横版",
        "荷花",
        "青绿"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 10,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 36,
          charactersPerLine: 9,
          lineCount: 4,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-wide-window-shadow",
    name: "窗影横笺",
    version: 1,
    width: 290,
    height: 230,
    backgroundColor: "#fcf8f0",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/wide-shadow.jpg",
        prompt: "横版中国风背景，窗棂与竹枝影投在宣纸上，中央留白，极简光影，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 230,
        objectFit: "cover",
        objectPosition: "42% 50%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 76,
        y: 46,
        width: 138,
        height: 72,
        fontSize: 22,
        color: "#2e2922",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "end",
        textAlign: "center"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 58,
        y: 115,
        width: 174,
        height: 82,
        fontSize: 13,
        color: "rgba(46, 41, 34, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 3,
        blockAlign: "start",
        textAlign: "center"
      },
      {
        id: "line-1",
        type: "line",
        x: 110,
        y: 32,
        length: 70,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(46, 41, 34, 0.22)",
        zIndex: 10
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "横版",
        "光影",
        "窗影"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 12,
      weight: 8,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 12,
          charactersPerLine: 6,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 39,
          charactersPerLine: 13,
          lineCount: 3,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-wide-plum-corner",
    name: "梅枝角笺",
    version: 1,
    width: 290,
    height: 237.14300537109375,
    backgroundColor: "#fdf8f2",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/wide-plum.jpg",
        prompt: "横版中国风背景，疏朗梅枝从边角伸出，浅粉淡墨，留白充足，宣纸质感，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 240,
        objectFit: "cover",
        objectPosition: "50% 40%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "quote",
        type: "text",
        role: "decoration",
        content: "“",
        x: -13,
        y: 112,
        width: 72,
        height: 68,
        fontSize: 62,
        color: "rgba(118, 56, 48, 0.12)",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 0,
        lineHeight: 1,
        maxLines: 1,
        textAlign: "left",
        blockAlign: "start"
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 16,
        y: 143,
        width: 136,
        height: 72,
        fontSize: 22,
        color: "#3b2724",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 1,
        blockAlign: "start",
        textAlign: "left"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 18,
        y: 176,
        width: 248,
        height: 82,
        fontSize: 13,
        color: "rgba(59, 39, 36, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 2,
        blockAlign: "start"
      },
      {
        id: "seal",
        type: "image",
        role: "stamp",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/seal-kongshengmiaoyou.png",
        prompt: "朱文篆刻印章素材，四字为「空生妙有」，传统四字印章读法为右上空、右下生、左上妙、左下有，小篆风格，红印泥质感。",
        x: 236,
        y: 20,
        width: 30,
        height: 30,
        objectFit: "contain",
        objectPosition: "50% 50%",
        opacity: 0.9,
        shape: "rectangle",
        zIndex: 24
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "横版",
        "梅花",
        "浅粉"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 5,
      weight: 9,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 5,
          charactersPerLine: 5,
          lineCount: 1,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 38,
          charactersPerLine: 19,
          lineCount: 2,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-wide-koi-flow",
    name: "锦鲤流白",
    version: 1,
    width: 290,
    height: 248.8570556640625,
    backgroundColor: "#fbf8ef",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/wide-koi.jpg",
        prompt: "横版中国风背景，两三条写意锦鲤与轻水纹位于右下，朱橘点睛，大面积留白，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 250,
        objectFit: "cover",
        objectPosition: "62% 58%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 142,
        y: 31,
        width: 124,
        height: 72,
        fontSize: 22,
        color: "#2c3434",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 1,
        blockAlign: "start"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 145,
        y: 70,
        width: 122,
        height: 82,
        fontSize: 13,
        color: "rgba(44, 52, 52, 0.64)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 4,
        blockAlign: "start"
      },
      {
        id: "line-1",
        type: "line",
        x: 148,
        y: 173.07135009765625,
        length: 58,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(173, 80, 49, 0.32)",
        zIndex: 10
      },
      {
        id: "seal",
        type: "image",
        role: "stamp",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/seal-kongshengmiaoyou.png",
        prompt: "朱文篆刻印章素材，四字为「空生妙有」，传统四字印章读法为右上空、右下生、左上妙、左下有，小篆风格，红印泥质感。",
        x: 22.28582763671875,
        y: 32,
        width: 30,
        height: 30,
        objectFit: "contain",
        objectPosition: "50% 50%",
        opacity: 0.9,
        shape: "rectangle",
        zIndex: 24
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "横版",
        "锦鲤",
        "水纹"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 5,
      weight: 10,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 5,
          charactersPerLine: 5,
          lineCount: 1,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 36,
          charactersPerLine: 9,
          lineCount: 4,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-square-bamboo-orchid",
    name: "竹兰右文",
    version: 1,
    width: 290,
    height: 330,
    backgroundColor: "#fbf8f0",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/square-bamboo-orchid.jpg",
        prompt: "方形中国风背景，竹与兰草位于左下，山石极淡，右上留白，青灰淡墨，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 330,
        objectFit: "cover",
        objectPosition: "38% 54%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 146,
        y: 58,
        width: 124,
        height: 72,
        fontSize: 22,
        color: "#21352f",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "start"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 146,
        y: 122,
        width: 108,
        height: 82,
        fontSize: 13,
        color: "rgba(33, 53, 47, 0.64)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 4,
        blockAlign: "start"
      },
      {
        id: "line-1",
        type: "line",
        x: 146,
        y: 276,
        length: 48,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(33, 53, 47, 0.24)",
        zIndex: 10
      },
      {
        id: "seal",
        type: "image",
        role: "stamp",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/seal-kongshengmiaoyou.png",
        prompt: "朱文篆刻印章素材，四字为「空生妙有」，传统四字印章读法为右上空、右下生、左上妙、左下有，小篆风格，红印泥质感。",
        x: 19.85723876953125,
        y: 17.71417236328125,
        width: 30,
        height: 30,
        objectFit: "contain",
        objectPosition: "50% 50%",
        opacity: 0.9,
        shape: "rectangle",
        zIndex: 24
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "方形",
        "竹兰",
        "青绿"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 10,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 32,
          charactersPerLine: 8,
          lineCount: 4,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-square-bird-left-text",
    name: "枝鸟左题",
    version: 1,
    width: 290,
    height: 320,
    backgroundColor: "#fcf8f1",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/square-bird-branch.jpg",
        prompt: "方形中国风背景，小鸟停在疏枝上，主体在右侧，左侧留白，宣纸淡彩，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 320,
        objectFit: "cover",
        objectPosition: "62% 42%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "quote",
        type: "text",
        role: "decoration",
        content: "“",
        x: -4,
        y: 54,
        width: 66,
        height: 72,
        fontSize: 72,
        color: "rgba(68, 49, 37, 0.09)",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 0,
        lineHeight: 1,
        maxLines: 1,
        textAlign: "left",
        blockAlign: "start"
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 34,
        y: 100,
        width: 116,
        height: 72,
        fontSize: 22,
        color: "#342b24",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "start"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 34,
        y: 164,
        width: 118,
        height: 82,
        fontSize: 13,
        color: "rgba(52, 43, 36, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 4,
        blockAlign: "start"
      },
      {
        id: "line-1",
        type: "line",
        x: 34,
        y: 282,
        length: 52,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(52, 43, 36, 0.22)",
        zIndex: 10
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "方形",
        "花鸟",
        "枝头"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 10,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 36,
          charactersPerLine: 9,
          lineCount: 4,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-square-shrimp-diagonal",
    name: "斜水虾笺",
    version: 1,
    width: 290,
    height: 317.1427001953125,
    backgroundColor: "#fbfaf4",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/square-shrimp.jpg",
        prompt: "方形中国风背景，水墨虾与斜向水纹集中一角，构图清简，留白充足，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 320,
        objectFit: "cover",
        objectPosition: "44% 56%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 150,
        y: 48,
        width: 120,
        height: 72,
        fontSize: 22,
        color: "#263335",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "start"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 150,
        y: 112,
        width: 116,
        height: 82,
        fontSize: 13,
        color: "rgba(38, 51, 53, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 4,
        blockAlign: "start"
      },
      {
        id: "seal",
        type: "image",
        role: "stamp",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/seal-kongshengmiaoyou.png",
        prompt: "朱文篆刻印章素材，四字为「空生妙有」，传统四字印章读法为右上空、右下生、左上妙、左下有，小篆风格，红印泥质感。",
        x: 23.428466796875,
        y: 21,
        width: 30,
        height: 30,
        objectFit: "contain",
        objectPosition: "50% 50%",
        opacity: 0.9,
        shape: "rectangle",
        zIndex: 24
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "方形",
        "水墨虾",
        "斜线"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 9,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 32,
          charactersPerLine: 8,
          lineCount: 4,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-square-paper-quote",
    name: "纸枝引语",
    version: 1,
    width: 290,
    height: 309.8570556640625,
    backgroundColor: "#fcf8f0",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/square-paper-branch.jpg",
        prompt: "方形中国风背景，宣纸拼贴、小枝与淡云纹，米白旧纸色，大面积留白，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 315,
        objectFit: "cover",
        objectPosition: "58% 58%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "quote",
        type: "text",
        role: "decoration",
        content: "“",
        x: 3,
        y: 43,
        width: 78,
        height: 82,
        fontSize: 86,
        color: "rgba(95, 64, 40, 0.09)",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 0,
        lineHeight: 1,
        maxLines: 1,
        textAlign: "left",
        blockAlign: "start"
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 46,
        y: 98,
        width: 134,
        height: 72,
        fontSize: 22,
        color: "#33271f",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "start"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 46,
        y: 170,
        width: 132,
        height: 82,
        fontSize: 13,
        color: "rgba(51, 39, 31, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 3,
        blockAlign: "start"
      },
      {
        id: "line-1",
        type: "line",
        x: 29.5,
        y: 170.5,
        length: 70,
        direction: "vertical",
        thickness: 0.5,
        color: "rgba(95, 64, 40, 0.18)",
        zIndex: 10
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "方形",
        "纸艺",
        "引号"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 9,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 30,
          charactersPerLine: 10,
          lineCount: 3,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-square-egret-vertical",
    name: "白鹭竖题",
    version: 1,
    width: 290,
    height: 335,
    backgroundColor: "#fbf8f0",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/square-egret.jpg",
        prompt: "方形中国风背景，白鹭与水边芦苇位于下方一角，浅墨青灰，留白充足，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 335,
        objectFit: "cover",
        objectPosition: "42% 58%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 104.5,
        y: 24.2855224609375,
        width: 156,
        height: 150,
        fontSize: 22,
        color: "#253232",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "start",
        textAlign: "right"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 134.5,
        y: 89.5,
        width: 126,
        height: 82,
        fontSize: 13,
        color: "rgba(37, 50, 50, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 3,
        blockAlign: "start",
        textAlign: "right"
      },
      {
        id: "line-1",
        type: "line",
        x: 104,
        y: 208,
        length: 54,
        direction: "vertical",
        thickness: 0.5,
        color: "rgba(37, 50, 50, 0.24)",
        zIndex: 10
      },
      {
        id: "seal",
        type: "image",
        role: "stamp",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/seal-kongshengmiaoyou.png",
        prompt: "朱文篆刻印章素材，四字为「空生妙有」，传统四字印章读法为右上空、右下生、左上妙、左下有，小篆风格，红印泥质感。",
        x: 232.5,
        y: 276,
        width: 30,
        height: 30,
        objectFit: "contain",
        objectPosition: "50% 50%",
        opacity: 0.9,
        shape: "rectangle",
        zIndex: 24
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "方形",
        "白鹭",
        "竖排"
      ],
      requiresImage: !1,
      preferVerticalText: !0,
      maxTitleLength: 12,
      weight: 11,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 12,
          charactersPerLine: 6,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 27,
          charactersPerLine: 9,
          lineCount: 3,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-tall-peach-columns",
    name: "垂桃双列",
    version: 1,
    width: 290,
    height: 460,
    backgroundColor: "#fdf8f2",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/tall-peach.jpg",
        prompt: "竖版中国风背景，垂落桃花枝从上方伸入，浅桃粉淡墨，中右留白，宣纸质感，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 460,
        objectFit: "cover",
        objectPosition: "42% 46%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 206,
        y: 81,
        width: 54,
        height: 244,
        fontSize: 22,
        color: "#3a2522",
        direction: "vertical",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 1,
        blockAlign: "start"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 147.5,
        y: 115,
        width: 54,
        height: 284,
        fontSize: 13,
        color: "rgba(58, 37, 34, 0.62)",
        direction: "vertical",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.55,
        maxLines: 2,
        blockAlign: "start"
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "竖版",
        "桃花",
        "双列"
      ],
      requiresImage: !1,
      preferVerticalText: !0,
      maxTitleLength: 10,
      weight: 12,
      textCapacity: {
        title: {
          direction: "vertical",
          maxCharacters: 10,
          charactersPerColumn: 10,
          columnCount: 1,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "vertical",
          maxCharacters: 42,
          charactersPerColumn: 21,
          columnCount: 2,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.55
        }
      }
    }
  },
  {
    id: "curated-tall-lotus-bottom",
    name: "下荷上题",
    version: 1,
    width: 290,
    height: 450,
    backgroundColor: "#fbf8ef",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/tall-lotus.jpg",
        prompt: "竖版中国风背景，荷叶与莲蓬位于底部，浅青绿，顶部大留白，宣纸米白底，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 450,
        objectFit: "cover",
        objectPosition: "54% 62%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 34,
        y: 54,
        width: 134,
        height: 72,
        fontSize: 22,
        color: "#21342f",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "end"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 34,
        y: 120,
        width: 130,
        height: 82,
        fontSize: 13,
        color: "rgba(33, 52, 47, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 4,
        blockAlign: "start"
      },
      {
        id: "line-1",
        type: "line",
        x: 34,
        y: 278,
        length: 74,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(33, 52, 47, 0.24)",
        zIndex: 10
      },
      {
        id: "seal",
        type: "image",
        role: "stamp",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/seal-kongshengmiaoyou.png",
        prompt: "朱文篆刻印章素材，四字为「空生妙有」，传统四字印章读法为右上空、右下生、左上妙、左下有，小篆风格，红印泥质感。",
        x: 238.571533203125,
        y: 26,
        width: 30,
        height: 30,
        objectFit: "contain",
        objectPosition: "50% 50%",
        opacity: 0.9,
        shape: "rectangle",
        zIndex: 24
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "竖版",
        "荷叶",
        "留白"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 10,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 40,
          charactersPerLine: 10,
          lineCount: 4,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-tall-pine-mountain",
    name: "松山竖札",
    version: 1,
    width: 290,
    height: 470,
    backgroundColor: "#fbf8f1",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/tall-pine-mountain.jpg",
        prompt: "竖版中国风背景，松树山石与远山位于底部，淡墨灰，右上留白，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 470,
        objectFit: "cover",
        objectPosition: "48% 58%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 212,
        y: 72,
        width: 52,
        height: 264,
        fontSize: 22,
        color: "#26343a",
        direction: "vertical",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 1,
        blockAlign: "start"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 154,
        y: 72,
        width: 54,
        height: 264,
        fontSize: 13,
        color: "rgba(38, 52, 58, 0.62)",
        direction: "vertical",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.55,
        maxLines: 2,
        blockAlign: "start"
      },
      {
        id: "seal",
        type: "image",
        role: "stamp",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/seal-kongshengmiaoyou.png",
        prompt: "朱文篆刻印章素材，四字为「空生妙有」，传统四字印章读法为右上空、右下生、左上妙、左下有，小篆风格，红印泥质感。",
        x: 22,
        y: 23,
        width: 30,
        height: 30,
        objectFit: "contain",
        objectPosition: "50% 50%",
        opacity: 0.9,
        shape: "rectangle",
        zIndex: 24
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "竖版",
        "松山",
        "竖排"
      ],
      requiresImage: !1,
      preferVerticalText: !0,
      maxTitleLength: 11,
      weight: 11,
      textCapacity: {
        title: {
          direction: "vertical",
          maxCharacters: 11,
          charactersPerColumn: 11,
          columnCount: 1,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "vertical",
          maxCharacters: 40,
          charactersPerColumn: 20,
          columnCount: 2,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.55
        }
      }
    }
  },
  {
    id: "curated-tall-kingfisher-bottom",
    name: "翠羽留白",
    version: 1,
    width: 290,
    height: 455,
    backgroundColor: "#fbf8f0",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/tall-kingfisher.jpg",
        prompt: "竖版中国风背景，水墨翠鸟与荷梗位于下方，青灰和少量橘色点睛，留白充足，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 455,
        objectFit: "cover",
        objectPosition: "46% 58%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 204,
        y: 62,
        width: 54,
        height: 236,
        fontSize: 22,
        color: "#183244",
        direction: "vertical",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 1,
        blockAlign: "start"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 58,
        y: 62,
        width: 156,
        height: 284,
        fontSize: 13,
        color: "rgba(24, 50, 68, 0.63)",
        direction: "vertical",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 3,
        blockAlign: "start"
      },
      {
        id: "seal",
        type: "image",
        role: "stamp",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/seal-kongshengmiaoyou.png",
        prompt: "朱文篆刻印章素材，四字为「空生妙有」，传统四字印章读法为右上空、右下生、左上妙、左下有，小篆风格，红印泥质感。",
        x: 230,
        y: 391.71429443359375,
        width: 30,
        height: 30,
        objectFit: "contain",
        objectPosition: "50% 50%",
        opacity: 0.9,
        shape: "rectangle",
        zIndex: 24
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "竖版",
        "翠鸟",
        "青绿"
      ],
      requiresImage: !1,
      preferVerticalText: !0,
      maxTitleLength: 10,
      weight: 12,
      textCapacity: {
        title: {
          direction: "vertical",
          maxCharacters: 10,
          charactersPerColumn: 10,
          columnCount: 1,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "vertical",
          maxCharacters: 63,
          charactersPerColumn: 21,
          columnCount: 3,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-tall-bamboo-quote",
    name: "竹影大引",
    version: 1,
    width: 290,
    height: 430,
    backgroundColor: "#fcf9f2",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/tall-bamboo-shadow.jpg",
        prompt: "竖版中国风极简背景，竹影自右侧映入米白宣纸，大片留白，非写实，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 430,
        objectFit: "cover",
        objectPosition: "58% 50%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "quote",
        type: "text",
        role: "decoration",
        content: "“",
        x: 25,
        y: 101,
        width: 86,
        height: 96,
        fontSize: 67,
        color: "rgba(37, 52, 47, 0.1)",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 0,
        lineHeight: 1,
        maxLines: 1,
        textAlign: "left",
        blockAlign: "start"
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 58,
        y: 152,
        width: 148,
        height: 72,
        fontSize: 22,
        color: "#25342f",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "end",
        textAlign: "left"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 58,
        y: 222,
        width: 148,
        height: 82,
        fontSize: 13,
        color: "rgba(37, 52, 47, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 4,
        blockAlign: "start"
      },
      {
        id: "line-1",
        type: "line",
        x: 58,
        y: 366,
        length: 86,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(37, 52, 47, 0.22)",
        zIndex: 10
      },
      {
        id: "seal",
        type: "image",
        role: "stamp",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/seal-kongshengmiaoyou.png",
        prompt: "朱文篆刻印章素材，四字为「空生妙有」，传统四字印章读法为右上空、右下生、左上妙、左下有，小篆风格，红印泥质感。",
        x: 226.4285888671875,
        y: 361.5,
        width: 30,
        height: 30,
        objectFit: "contain",
        objectPosition: "50% 50%",
        opacity: 0.9,
        shape: "rectangle",
        zIndex: 24
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "竖版",
        "竹影",
        "引号"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 12,
      weight: 9,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 12,
          charactersPerLine: 6,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 44,
          charactersPerLine: 11,
          lineCount: 4,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-square-chrysanthemum-mountain",
    name: "菊影淡山",
    version: 1,
    width: 290,
    height: 330,
    backgroundColor: "#fbf7ee",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/square-chrysanthemum.jpg",
        prompt: "方形中国风笔记背景，一簇疏朗菊花位于左下角，极淡远山，右上大面积宣纸留白，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 330,
        objectFit: "cover",
        objectPosition: "42% 56%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 142,
        y: 62,
        width: 124,
        height: 72,
        fontSize: 22,
        color: "#3b2f24",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "start"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 142,
        y: 126,
        width: 112,
        height: 82,
        fontSize: 13,
        color: "rgba(59, 47, 36, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 4,
        blockAlign: "start"
      },
      {
        id: "line-1",
        type: "line",
        x: 142,
        y: 278,
        length: 54,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(167, 119, 46, 0.28)",
        zIndex: 10
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "方形",
        "菊花",
        "远山"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 10,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 32,
          charactersPerLine: 8,
          lineCount: 4,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-tall-banana-rain",
    name: "芭蕉雨句",
    version: 1,
    width: 290,
    height: 455,
    backgroundColor: "#fbf8f0",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/tall-banana-leaf.jpg",
        prompt: "竖版中国风笔记背景，芭蕉叶从左下向中部舒展，浅青绿淡墨，右上与上方留白，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 455,
        objectFit: "cover",
        objectPosition: "48% 48%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 19.28546142578125,
        y: 80.5,
        width: 132,
        height: 168,
        fontSize: 22,
        color: "#233a34",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "end"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 21.28546142578125,
        y: 153.78567504882812,
        width: 132,
        height: 220,
        fontSize: 13,
        color: "rgba(35, 58, 52, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.55,
        maxLines: 3,
        blockAlign: "start"
      },
      {
        id: "line-1",
        type: "line",
        x: 21.28546142578125,
        y: 245.71426391601562,
        length: 68,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(35, 58, 52, 0.25)",
        zIndex: 10
      },
      {
        id: "seal",
        type: "image",
        role: "stamp",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/seal-kongshengmiaoyou.png",
        prompt: "朱文篆刻印章素材，四字为「空生妙有」，传统四字印章读法为右上空、右下生、左上妙、左下有，小篆风格，红印泥质感。",
        x: 21.28546142578125,
        y: 394.57147216796875,
        width: 30,
        height: 30,
        objectFit: "contain",
        objectPosition: "50% 50%",
        opacity: 0.9,
        shape: "rectangle",
        zIndex: 24
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "竖版",
        "芭蕉",
        "青绿"
      ],
      requiresImage: !1,
      preferVerticalText: !0,
      maxTitleLength: 10,
      weight: 11,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 30,
          charactersPerLine: 10,
          lineCount: 3,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.55
        }
      }
    }
  },
  {
    id: "curated-wide-taihu-stone",
    name: "石兰横记",
    version: 1,
    width: 290,
    height: 250,
    backgroundColor: "#fbf8ef",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/wide-taihu-stone.jpg",
        prompt: "横版中国风笔记背景，太湖石与兰草位于右侧偏下，左侧与上方大留白，淡赭灰宣纸，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 250,
        objectFit: "cover",
        objectPosition: "66% 56%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 30,
        y: 42,
        width: 122,
        height: 72,
        fontSize: 22,
        color: "#332d25",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "start"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 30,
        y: 104,
        width: 120,
        height: 82,
        fontSize: 13,
        color: "rgba(51, 45, 37, 0.63)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 4,
        blockAlign: "start"
      },
      {
        id: "line-1",
        type: "line",
        x: 30,
        y: 212,
        length: 68,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(51, 45, 37, 0.24)",
        zIndex: 10
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "横版",
        "太湖石",
        "兰草"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 10,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 36,
          charactersPerLine: 9,
          lineCount: 4,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-square-folding-fan-quote",
    name: "扇影引白",
    version: 1,
    width: 290,
    height: 320,
    backgroundColor: "#fcf8f1",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/square-folding-fan.jpg",
        prompt: "方形中国风笔记背景，半透明折扇影从左上角进入，米白宣纸，主体极淡，右下留白，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 320,
        objectFit: "cover",
        objectPosition: "48% 48%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 126,
        y: 131,
        width: 136,
        height: 72,
        fontSize: 22,
        color: "#32271f",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "end",
        textAlign: "right"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 127,
        y: 202,
        width: 134,
        height: 82,
        fontSize: 13,
        color: "rgba(50, 39, 31, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 3,
        blockAlign: "start",
        textAlign: "right"
      },
      {
        id: "line-1",
        type: "line",
        x: 186,
        y: 293.142822265625,
        length: 78,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(50, 39, 31, 0.2)",
        zIndex: 10
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "方形",
        "折扇",
        "引号"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 9,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 30,
          charactersPerLine: 10,
          lineCount: 3,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-tall-osmanthus-branch",
    name: "桂枝清札",
    version: 1,
    width: 290,
    height: 440,
    backgroundColor: "#fdf8ef",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/tall-osmanthus.jpg",
        prompt: "竖版中国风笔记背景，桂花枝从右侧伸入，淡黄点睛，左上留白，米白宣纸，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 440,
        objectFit: "cover",
        objectPosition: "58% 52%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 31,
        y: 50.42852783203125,
        width: 228,
        height: 312,
        fontSize: 22,
        color: "#3f311d",
        direction: "vertical",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 1,
        blockAlign: "start"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: -4,
        y: 80.42852783203125,
        width: 216,
        height: 256,
        fontSize: 13,
        color: "rgba(63, 49, 29, 0.62)",
        direction: "vertical",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 2,
        blockAlign: "start"
      },
      {
        id: "seal",
        type: "image",
        role: "stamp",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/seal-kongshengmiaoyou.png",
        prompt: "朱文篆刻印章素材，四字为「空生妙有」，传统四字印章读法为右上空、右下生、左上妙、左下有，小篆风格，红印泥质感。",
        x: 22.428466796875,
        y: 21.42852783203125,
        width: 30,
        height: 30,
        objectFit: "contain",
        objectPosition: "50% 50%",
        opacity: 0.9,
        shape: "rectangle",
        zIndex: 24
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "竖版",
        "桂花",
        "浅黄"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 13,
      weight: 10,
      textCapacity: {
        title: {
          direction: "vertical",
          maxCharacters: 13,
          charactersPerColumn: 13,
          columnCount: 1,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "vertical",
          maxCharacters: 38,
          charactersPerColumn: 19,
          columnCount: 2,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-wide-tea-smoke",
    name: "茶烟短章",
    version: 1,
    width: 290,
    height: 250,
    backgroundColor: "#fbf7ef",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/wide-tea-cup.jpg",
        prompt: "横版中国风笔记背景，茶盏位于左下角，淡茶烟气与旧纸色，右上留白，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 250,
        objectFit: "cover",
        objectPosition: "42% 58%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 148,
        y: 41,
        width: 116,
        height: 72,
        fontSize: 22,
        color: "#3a2c22",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "end"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 150,
        y: 108,
        width: 108,
        height: 82,
        fontSize: 13,
        color: "rgba(58, 44, 34, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 4,
        blockAlign: "start"
      },
      {
        id: "line-1",
        type: "line",
        x: 150,
        y: 216,
        length: 46,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(58, 44, 34, 0.24)",
        zIndex: 10
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "横版",
        "茶盏",
        "烟气"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 10,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 32,
          charactersPerLine: 8,
          lineCount: 4,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-square-porcelain-camellia",
    name: "瓷瓶山茶",
    version: 1,
    width: 290,
    height: 330,
    backgroundColor: "#fbf8ef",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/square-porcelain-camellia.jpg",
        prompt: "方形中国风笔记背景，淡青瓷瓶与一枝山茶位于下方中部，周围大片留白，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 330,
        objectFit: "cover",
        objectPosition: "50% 58%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 41,
        y: 48,
        width: 126,
        height: 72,
        fontSize: 22,
        color: "#253733",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "end"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 42,
        y: 118,
        width: 126,
        height: 82,
        fontSize: 13,
        color: "rgba(37, 55, 51, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 4,
        blockAlign: "start"
      },
      {
        id: "seal",
        type: "image",
        role: "stamp",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/seal-kongshengmiaoyou.png",
        prompt: "朱文篆刻印章素材，四字为「空生妙有」，传统四字印章读法为右上空、右下生、左上妙、左下有，小篆风格，红印泥质感。",
        x: 41,
        y: 270.71435546875,
        width: 30,
        height: 30,
        objectFit: "contain",
        objectPosition: "50% 50%",
        opacity: 0.9,
        shape: "rectangle",
        zIndex: 24
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "方形",
        "瓷瓶",
        "山茶"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 10,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 36,
          charactersPerLine: 9,
          lineCount: 4,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-tall-ginkgo-columns",
    name: "银杏双列",
    version: 1,
    width: 290,
    height: 455,
    backgroundColor: "#fdf8ef",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/tall-ginkgo.jpg",
        prompt: "竖版中国风笔记背景，银杏叶从右侧垂落，浅金黄点睛，左侧留白，宣纸底，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 455,
        objectFit: "cover",
        objectPosition: "56% 52%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 105,
        y: 69,
        width: 54,
        height: 244,
        fontSize: 22,
        color: "#4a3518",
        direction: "vertical",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 1,
        blockAlign: "start"
      },
      {
        id: "line-1",
        type: "line",
        x: 40,
        y: 294,
        length: 66,
        direction: "vertical",
        thickness: 0.5,
        color: "rgba(182, 137, 41, 0.28)",
        zIndex: 10
      },
      {
        id: "seal",
        type: "image",
        role: "stamp",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/seal-kongshengmiaoyou.png",
        prompt: "朱文篆刻印章素材，四字为「空生妙有」，传统四字印章读法为右上空、右下生、左上妙、左下有，小篆风格，红印泥质感。",
        x: 129,
        y: 28,
        width: 30,
        height: 30,
        objectFit: "contain",
        objectPosition: "50% 50%",
        opacity: 0.9,
        shape: "rectangle",
        zIndex: 24
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "竖版",
        "银杏",
        "双列"
      ],
      requiresImage: !1,
      preferVerticalText: !0,
      maxTitleLength: 10,
      weight: 10,
      textCapacity: {
        title: {
          direction: "vertical",
          maxCharacters: 10,
          charactersPerColumn: 10,
          columnCount: 1,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        }
      }
    }
  },
  {
    id: "curated-wide-roof-tile-pattern",
    name: "瓦纹索引",
    version: 1,
    width: 290,
    height: 240,
    backgroundColor: "#fbf8f0",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/wide-roof-tile.jpg",
        prompt: "横版中国风笔记背景，淡瓦当纹样位于左侧，右侧大留白，宣纸米白底，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 240,
        objectFit: "cover",
        objectPosition: "38% 52%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 140,
        y: 41,
        width: 132,
        height: 72,
        fontSize: 22,
        color: "#332b24",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "end"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 142,
        y: 108,
        width: 110,
        height: 82,
        fontSize: 13,
        color: "rgba(51, 43, 36, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 4,
        blockAlign: "start"
      },
      {
        id: "line-1",
        type: "line",
        x: 142,
        y: 214,
        length: 52,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(51, 43, 36, 0.2)",
        zIndex: 10
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "横版",
        "瓦当",
        "纹样"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 9,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 32,
          charactersPerLine: 8,
          lineCount: 4,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-tall-gourd-vine",
    name: "葫芦藤影",
    version: 1,
    width: 290,
    height: 455,
    backgroundColor: "#fbf8f0",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/tall-gourd-vine.jpg",
        prompt: "竖版中国风笔记背景，葫芦藤与叶片位于右下角，淡青绿与浅赭色，左上留白，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 455,
        objectFit: "cover",
        objectPosition: "58% 58%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 34,
        y: 57,
        width: 136,
        height: 72,
        fontSize: 22,
        color: "#2f3a2e",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "end"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 34,
        y: 132,
        width: 130,
        height: 82,
        fontSize: 13,
        color: "rgba(47, 58, 46, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 4,
        blockAlign: "start"
      },
      {
        id: "line-1",
        type: "line",
        x: 34,
        y: 320,
        length: 64,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(47, 58, 46, 0.24)",
        zIndex: 10
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "竖版",
        "葫芦",
        "藤蔓"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 10,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 40,
          charactersPerLine: 10,
          lineCount: 4,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-wide-bridge-mist",
    name: "石桥烟水",
    version: 1,
    width: 290,
    height: 260,
    backgroundColor: "#fbf8ef",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/wide-bridge-mist.jpg",
        prompt: "横版中国风笔记卡片背景，小石拱桥位于左下角，桥下极淡水面和水纹，远处淡墨岸影，右上大面积留白，宣纸米白底，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 260,
        objectFit: "cover",
        objectPosition: "44% 58%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 150,
        y: 42,
        width: 120,
        height: 68,
        fontSize: 22,
        color: "#25313a",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "start"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 150,
        y: 106,
        width: 116,
        height: 92,
        fontSize: 13,
        color: "rgba(37, 49, 58, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 4,
        blockAlign: "start"
      },
      {
        id: "line-1",
        type: "line",
        x: 150,
        y: 224,
        length: 54,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(37, 49, 58, 0.24)",
        zIndex: 10
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "横版",
        "桥",
        "水纹"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 10,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 32,
          charactersPerLine: 8,
          lineCount: 4,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-tall-bridge-willow",
    name: "桥畔柳影",
    version: 1,
    width: 290,
    height: 455,
    backgroundColor: "#fbf8f0",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/tall-bridge-willow.jpg",
        prompt: "竖版中国风笔记卡片背景，远处小拱桥与柳影位于下方偏右，左上与中上大面积留白，淡墨灰与浅青灰，宣纸底，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 455,
        objectFit: "cover",
        objectPosition: "54% 58%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 21.28594970703125,
        y: 31,
        width: 58,
        height: 276,
        fontSize: 22,
        color: "#26353a",
        direction: "vertical",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.36,
        maxLines: 1,
        blockAlign: "end"
      },
      {
        id: "line-1",
        type: "line",
        x: 226,
        y: 292,
        length: 66,
        direction: "vertical",
        thickness: 0.5,
        color: "rgba(38, 53, 58, 0.24)",
        zIndex: 10
      },
      {
        id: "seal",
        type: "image",
        role: "stamp",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/seal-kongshengmiaoyou.png",
        prompt: "朱文篆刻印章素材，四字为「空生妙有」，传统四字印章读法为右上空、右下生、左上妙、左下有，小篆风格，红印泥质感。",
        x: 239,
        y: 30,
        width: 30,
        height: 30,
        objectFit: "contain",
        objectPosition: "50% 50%",
        opacity: 0.9,
        shape: "rectangle",
        zIndex: 24
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "竖版",
        "桥",
        "柳影"
      ],
      requiresImage: !1,
      preferVerticalText: !0,
      maxTitleLength: 12,
      weight: 10,
      textCapacity: {
        title: {
          direction: "vertical",
          maxCharacters: 12,
          charactersPerColumn: 12,
          columnCount: 1,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.36
        }
      }
    }
  },
  {
    id: "curated-wide-incense-smoke",
    name: "炉烟横札",
    version: 1,
    width: 290,
    height: 250,
    backgroundColor: "#fbf7ee",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/wide-incense-smoke.jpg",
        prompt: "横版中国风笔记卡片背景，香炉位于左下角，细烟向上轻散，淡赭与旧纸色，右上干净留白，宣纸质感，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 250,
        objectFit: "cover",
        objectPosition: "42% 58%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 146,
        y: 44,
        width: 114,
        height: 68,
        fontSize: 22,
        color: "#3b2d22",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "start",
        textAlign: "right"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 146,
        y: 108,
        width: 114,
        height: 72,
        fontSize: 13,
        color: "rgba(59, 45, 34, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 3,
        blockAlign: "start",
        textAlign: "right"
      },
      {
        id: "line-1",
        type: "line",
        x: 202,
        y: 210,
        length: 58,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(59, 45, 34, 0.25)",
        zIndex: 10
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "横版",
        "香炉",
        "烟气"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 8,
      weight: 10,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 8,
          charactersPerLine: 4,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 24,
          charactersPerLine: 8,
          lineCount: 3,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-square-incense-vessel",
    name: "香炉清供",
    version: 1,
    width: 290,
    height: 330,
    backgroundColor: "#fbf8f0",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/square-incense-vessel.jpg",
        prompt: "方形中国风笔记卡片背景，小香炉与一缕烟位于下方一角，浅赭灰和淡墨，周围大片留白，非写实国画感，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 330,
        objectFit: "cover",
        objectPosition: "50% 58%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "quote",
        type: "text",
        role: "decoration",
        content: "“",
        x: 78,
        y: 32.5,
        width: 70,
        height: 78,
        fontSize: 71,
        color: "rgba(76, 51, 34, 0.09)",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 0,
        lineHeight: 1,
        maxLines: 1,
        textAlign: "left",
        blockAlign: "start"
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 112,
        y: 68,
        width: 144,
        height: 68,
        fontSize: 22,
        color: "#3c2d23",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "end",
        textAlign: "left"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 115,
        y: 138,
        width: 136,
        height: 92,
        fontSize: 13,
        color: "rgba(60, 45, 35, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 4,
        blockAlign: "start",
        textAlign: "left"
      },
      {
        id: "line-1",
        type: "line",
        x: 115,
        y: 237.5,
        length: 52,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(60, 45, 35, 0.22)",
        zIndex: 10
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "方形",
        "香炉",
        "引号"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 12,
      weight: 10,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 12,
          charactersPerLine: 6,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 40,
          charactersPerLine: 10,
          lineCount: 4,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-wide-eave-bell",
    name: "檐铃听风",
    version: 1,
    width: 290,
    height: 250,
    backgroundColor: "#fbf7ef",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/wide-eave-bell.jpg",
        prompt: "横版中国风笔记卡片背景，屋檐与风铃从右上角探入，主体不居中，左侧和下方留白，淡墨旧木色，宣纸底，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 250,
        objectFit: "cover",
        objectPosition: "58% 44%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 30,
        y: 34,
        width: 118,
        height: 68,
        fontSize: 22,
        color: "#352920",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "end"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 30,
        y: 106,
        width: 116,
        height: 92,
        fontSize: 13,
        color: "rgba(53, 41, 32, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 4,
        blockAlign: "start"
      },
      {
        id: "line-1",
        type: "line",
        x: 30,
        y: 218,
        length: 62,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(53, 41, 32, 0.22)",
        zIndex: 10
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "横版",
        "屋檐",
        "风铃"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 10,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 32,
          charactersPerLine: 8,
          lineCount: 4,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-tall-eave-bell",
    name: "檐角风铃",
    version: 1,
    width: 290,
    height: 455,
    backgroundColor: "#fbf8f1",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/tall-eave-bell.jpg",
        prompt: "竖版中国风笔记卡片背景，屋檐和风铃位于上方偏右，风铃轻垂，中下与左侧保留留白，淡墨与浅赭色，宣纸质感，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 455,
        objectFit: "cover",
        objectPosition: "58% 42%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 224.5,
        y: 224,
        width: 40,
        height: 180,
        fontSize: 22,
        color: "#342920",
        direction: "vertical",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "end"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 77,
        y: 224,
        width: 134,
        height: 208,
        fontSize: 13,
        color: "rgba(52, 41, 32, 0.62)",
        direction: "vertical",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 3,
        blockAlign: "start"
      },
      {
        id: "seal",
        type: "image",
        role: "stamp",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/seal-kongshengmiaoyou.png",
        prompt: "朱文篆刻印章素材，四字为「空生妙有」，传统四字印章读法为右上空、右下生、左上妙、左下有，小篆风格，红印泥质感。",
        x: 225.5,
        y: 25.071441650390625,
        width: 30,
        height: 30,
        objectFit: "contain",
        objectPosition: "50% 50%",
        opacity: 0.9,
        shape: "rectangle",
        zIndex: 24
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "竖版",
        "屋檐",
        "风铃"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 14,
      weight: 10,
      textCapacity: {
        title: {
          direction: "vertical",
          maxCharacters: 14,
          charactersPerColumn: 7,
          columnCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "vertical",
          maxCharacters: 48,
          charactersPerColumn: 16,
          columnCount: 3,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-wide-red-crowned-crane",
    name: "鹤立浅水",
    version: 1,
    width: 290,
    height: 260,
    backgroundColor: "#fbf8f1",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/wide-red-crowned-crane.jpg",
        prompt: "横版中国风笔记卡片背景，丹顶鹤位于右下浅水边，姿态疏朗，左侧大面积留白，淡墨灰和少量朱红点睛，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 260,
        objectFit: "cover",
        objectPosition: "58% 58%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "quote",
        type: "text",
        role: "decoration",
        content: "“",
        x: 107,
        y: 40.5,
        width: 70,
        height: 80,
        fontSize: 61,
        color: "rgba(36, 48, 52, 0.08)",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 0,
        lineHeight: 1,
        maxLines: 1,
        textAlign: "left",
        blockAlign: "start"
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 137,
        y: 76,
        width: 118,
        height: 68,
        fontSize: 22,
        color: "#243034",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "end",
        textAlign: "left"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 139,
        y: 143,
        width: 122,
        height: 72,
        fontSize: 13,
        color: "rgba(36, 48, 52, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 3,
        blockAlign: "start"
      },
      {
        id: "line-1",
        type: "line",
        x: 193,
        y: 237.42852783203125,
        length: 64,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(138, 46, 38, 0.24)",
        zIndex: 10
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "横版",
        "丹顶鹤",
        "引号"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 11,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 27,
          charactersPerLine: 9,
          lineCount: 3,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-tall-red-crowned-crane",
    name: "丹鹤立雪",
    version: 1,
    width: 290,
    height: 455,
    backgroundColor: "#fbf8f2",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/tall-red-crowned-crane.jpg",
        prompt: "竖版中国风笔记卡片背景，丹顶鹤位于下方一角，顶部与侧边大面积宣纸留白，淡墨灰与极少朱红，国画写意，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 455,
        objectFit: "cover",
        objectPosition: "50% 60%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 75.4285888671875,
        y: 41,
        width: 58,
        height: 288,
        fontSize: 22,
        color: "#273236",
        direction: "vertical",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 1,
        blockAlign: "end"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 6.4285888671875,
        y: 42,
        width: 58,
        height: 288,
        fontSize: 13,
        color: "rgba(39, 50, 54, 0.62)",
        direction: "vertical",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.55,
        maxLines: 2,
        blockAlign: "start"
      },
      {
        id: "line-1",
        type: "line",
        x: 222,
        y: 286,
        length: 64,
        direction: "vertical",
        thickness: 0.5,
        color: "rgba(139, 48, 40, 0.25)",
        zIndex: 10
      },
      {
        id: "seal",
        type: "image",
        role: "stamp",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/seal-kongshengmiaoyou.png",
        prompt: "朱文篆刻印章素材，四字为「空生妙有」，传统四字印章读法为右上空、右下生、左上妙、左下有，小篆风格，红印泥质感。",
        x: 239.5,
        y: 38,
        width: 30,
        height: 30,
        objectFit: "contain",
        objectPosition: "50% 50%",
        opacity: 0.9,
        shape: "rectangle",
        zIndex: 24
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "竖版",
        "丹顶鹤",
        "竖排"
      ],
      requiresImage: !1,
      preferVerticalText: !0,
      maxTitleLength: 12,
      weight: 11,
      textCapacity: {
        title: {
          direction: "vertical",
          maxCharacters: 12,
          charactersPerColumn: 12,
          columnCount: 1,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "vertical",
          maxCharacters: 44,
          charactersPerColumn: 22,
          columnCount: 2,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.55
        }
      }
    }
  },
  {
    id: "curated-square-orange-cat-ball",
    name: "橘猫弄球",
    version: 1,
    width: 290,
    height: 330,
    backgroundColor: "#fbf7ef",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/square-orange-cat-ball.jpg",
        prompt: "方形中国风笔记卡片背景，橘猫玩线球，水墨淡彩表现，主体位于下方偏左，右上留白，温润浅赭色，宣纸底，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 330,
        objectFit: "cover",
        objectPosition: "46% 58%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "quote",
        type: "text",
        role: "decoration",
        content: "“",
        x: 190,
        y: 31,
        width: 74,
        height: 80,
        fontSize: 71,
        color: "rgba(126, 68, 31, 0.1)",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 0,
        lineHeight: 1,
        maxLines: 1,
        textAlign: "left",
        blockAlign: "start"
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 141,
        y: 88,
        width: 116,
        height: 68,
        fontSize: 22,
        color: "#4a2d1e",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "end",
        textAlign: "right"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 122,
        y: 162,
        width: 136,
        height: 70,
        fontSize: 13,
        color: "rgba(74, 45, 30, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 3,
        blockAlign: "start",
        textAlign: "right"
      },
      {
        id: "line-1",
        type: "line",
        x: 184,
        y: 252.85714721679688,
        length: 76,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(126, 68, 31, 0.22)",
        zIndex: 10
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "方形",
        "橘猫",
        "玩球"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 11,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 30,
          charactersPerLine: 10,
          lineCount: 3,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-wide-orange-cat-ball",
    name: "猫戏藤球",
    version: 1,
    width: 290,
    height: 250,
    backgroundColor: "#fbf7ee",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/wide-orange-cat-ball.jpg",
        prompt: "横版中国风笔记卡片背景，橘猫与小球位于右下角，留白主要在左侧和中上，淡赭与米白宣纸，非写实淡彩，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 250,
        objectFit: "cover",
        objectPosition: "58% 58%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 29,
        y: 54,
        width: 156,
        height: 68,
        fontSize: 22,
        color: "#4a2d1d",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "start"
      },
      {
        id: "line-1",
        type: "line",
        x: 30,
        y: 41.5,
        length: 64,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(126, 68, 31, 0.24)",
        zIndex: 10
      },
      {
        id: "seal",
        type: "image",
        role: "stamp",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/seal-kongshengmiaoyou.png",
        prompt: "朱文篆刻印章素材，四字为「空生妙有」，传统四字印章读法为右上空、右下生、左上妙、左下有，小篆风格，红印泥质感。",
        x: 32,
        y: 155.28570556640625,
        width: 30,
        height: 30,
        objectFit: "contain",
        objectPosition: "50% 50%",
        opacity: 0.9,
        shape: "rectangle",
        zIndex: 24
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "横版",
        "橘猫",
        "玩球"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 12,
      weight: 10,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 12,
          charactersPerLine: 6,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        }
      }
    }
  },
  {
    id: "curated-wide-withered-tree-crow",
    name: "枯藤昏鸦",
    version: 1,
    width: 290,
    height: 270,
    backgroundColor: "#fbf8f1",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/wide-withered-tree-crow.jpg",
        prompt: "横版中国风笔记卡片背景，枯藤老树与昏鸦位于左侧，远景极淡，右侧大面积留白，淡墨灰与旧纸色，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 270,
        objectFit: "cover",
        objectPosition: "42% 52%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 130,
        y: 34.7142333984375,
        width: 124,
        height: 68,
        fontSize: 22,
        color: "#2c2924",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "end",
        textAlign: "right"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 129,
        y: 106.7142333984375,
        width: 124,
        height: 92,
        fontSize: 13,
        color: "rgba(44, 41, 36, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 4,
        blockAlign: "start",
        textAlign: "right"
      },
      {
        id: "line-1",
        type: "line",
        x: 199,
        y: 215,
        length: 56,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(44, 41, 36, 0.24)",
        zIndex: 10
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "横版",
        "枯藤",
        "昏鸦"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 11,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 36,
          charactersPerLine: 9,
          lineCount: 4,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-tall-withered-tree-crow",
    name: "老树归鸦",
    version: 1,
    width: 290,
    height: 455,
    backgroundColor: "#fbf8f1",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/tall-withered-tree-crow.jpg",
        prompt: "竖版中国风笔记卡片背景，枯藤老树昏鸦位于下方与左侧，枝干疏朗，右上干净留白，淡墨灰宣纸，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 455,
        objectFit: "cover",
        objectPosition: "46% 56%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 31.57135009765625,
        y: 157,
        width: 58,
        height: 208,
        fontSize: 22,
        color: "#2c2924",
        direction: "vertical",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 1,
        blockAlign: "start"
      },
      {
        id: "line-1",
        type: "line",
        x: 224,
        y: 292,
        length: 66,
        direction: "vertical",
        thickness: 0.5,
        color: "rgba(44, 41, 36, 0.24)",
        zIndex: 10
      },
      {
        id: "seal",
        type: "image",
        role: "stamp",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/seal-kongshengmiaoyou.png",
        prompt: "朱文篆刻印章素材，四字为「空生妙有」，传统四字印章读法为右上空、右下生、左上妙、左下有，小篆风格，红印泥质感。",
        x: 59.57135009765625,
        y: 397.142822265625,
        width: 30,
        height: 30,
        objectFit: "contain",
        objectPosition: "50% 50%",
        opacity: 0.9,
        shape: "rectangle",
        zIndex: 24
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "竖版",
        "枯藤",
        "昏鸦"
      ],
      requiresImage: !1,
      preferVerticalText: !0,
      maxTitleLength: 9,
      weight: 11,
      textCapacity: {
        title: {
          direction: "vertical",
          maxCharacters: 9,
          charactersPerColumn: 9,
          columnCount: 1,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        }
      }
    }
  },
  {
    id: "curated-wide-willow-boat",
    name: "柳岸扁舟",
    version: 1,
    width: 290,
    height: 260,
    backgroundColor: "#fbf8ef",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/wide-willow-boat.jpg",
        prompt: "横版中国风笔记卡片背景，柳树与一叶扁舟位于左下水面，右侧大面积留白，浅青绿与淡墨灰，宣纸底，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 260,
        objectFit: "cover",
        objectPosition: "44% 58%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 148,
        y: 44,
        width: 128,
        height: 68,
        fontSize: 22,
        color: "#243832",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "start"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 148,
        y: 108,
        width: 112,
        height: 92,
        fontSize: 13,
        color: "rgba(36, 56, 50, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 4,
        blockAlign: "start"
      },
      {
        id: "line-1",
        type: "line",
        x: 148,
        y: 226,
        length: 58,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(36, 56, 50, 0.24)",
        zIndex: 10
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "横版",
        "柳树",
        "扁舟"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 10,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 32,
          charactersPerLine: 8,
          lineCount: 4,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-tall-willow-boat",
    name: "柳色行舟",
    version: 1,
    width: 290,
    height: 455,
    backgroundColor: "#fbf8ef",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/tall-willow-boat.jpg",
        prompt: "竖版中国风笔记卡片背景，柳枝垂落与远处扁舟位于下方，顶部和右上大面积留白，浅青绿低饱和，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 455,
        objectFit: "cover",
        objectPosition: "50% 56%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 33,
        y: 57,
        width: 132,
        height: 68,
        fontSize: 22,
        color: "#243832",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "end"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 34,
        y: 134,
        width: 132,
        height: 92,
        fontSize: 13,
        color: "rgba(36, 56, 50, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 4,
        blockAlign: "start"
      },
      {
        id: "line-1",
        type: "line",
        x: 204,
        y: 292,
        length: 66,
        direction: "vertical",
        thickness: 0.5,
        color: "rgba(36, 56, 50, 0.24)",
        zIndex: 10
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "竖版",
        "柳树",
        "扁舟"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 10,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 40,
          charactersPerLine: 10,
          lineCount: 4,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-wide-moon-gate-bamboo",
    name: "月门竹影",
    version: 1,
    width: 290,
    height: 260,
    backgroundColor: "#fbf8f0",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/wide-moon-gate-bamboo.jpg",
        prompt: "横版中国风笔记卡片背景，江南月洞门与竹影位于左下角，右上大面积留白，淡墨灰与浅竹青，宣纸底，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 260,
        objectFit: "cover",
        objectPosition: "42% 56%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 150,
        y: 42,
        width: 132,
        height: 68,
        fontSize: 22,
        color: "#26352f",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "start"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 150,
        y: 108,
        width: 112,
        height: 88,
        fontSize: 13,
        color: "rgba(38, 53, 47, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 4,
        blockAlign: "start"
      },
      {
        id: "line-1",
        type: "line",
        x: 150,
        y: 224,
        length: 56,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(38, 53, 47, 0.24)",
        zIndex: 10
      },
      {
        id: "seal",
        type: "image",
        role: "stamp",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/seal-kongshengmiaoyou.png",
        prompt: "朱文篆刻印章素材，四字为「空生妙有」，传统四字印章读法为右上空、右下生、左上妙、左下有，小篆风格，红印泥质感。",
        x: 26.57147216796875,
        y: 23,
        width: 30,
        height: 30,
        objectFit: "contain",
        objectPosition: "50% 50%",
        opacity: 0.9,
        shape: "rectangle",
        zIndex: 24
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "横版",
        "月洞门",
        "竹影"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 10,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 32,
          charactersPerLine: 8,
          lineCount: 4,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-tall-palace-lantern",
    name: "灯影檐声",
    version: 1,
    width: 290,
    height: 455,
    backgroundColor: "#fbf7ef",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/tall-palace-lantern.jpg",
        prompt: "竖版中国风笔记卡片背景，宫灯与檐影从右上垂下，左侧与下方留白，淡赭和少量朱砂红，宣纸质感，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 455,
        objectFit: "cover",
        objectPosition: "58% 42%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 21,
        y: 202.71429443359375,
        width: 136,
        height: 68,
        fontSize: 22,
        color: "#3b2a21",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "end"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 23,
        y: 270,
        width: 136,
        height: 72,
        fontSize: 13,
        color: "rgba(59, 42, 33, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 3,
        blockAlign: "start"
      },
      {
        id: "seal",
        type: "image",
        role: "stamp",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/seal-kongshengmiaoyou.png",
        prompt: "朱文篆刻印章素材，四字为「空生妙有」，传统四字印章读法为右上空、右下生、左上妙、左下有，小篆风格，红印泥质感。",
        x: 22,
        y: 394.28570556640625,
        width: 30,
        height: 30,
        objectFit: "contain",
        objectPosition: "50% 50%",
        opacity: 0.9,
        shape: "rectangle",
        zIndex: 24
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "竖版",
        "宫灯",
        "屋檐"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 10,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 30,
          charactersPerLine: 10,
          lineCount: 3,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-wide-guqin-plum",
    name: "琴上疏梅",
    version: 1,
    width: 290,
    height: 258.857177734375,
    backgroundColor: "#fbf7ef",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/wide-guqin-plum.jpg",
        prompt: "横版中国风笔记卡片背景，古琴局部与一枝疏梅位于左下角，右侧和上方留白，旧木赭色与淡墨浅粉，无文字。",
        x: 0,
        y: -2,
        width: 290,
        height: 260,
        objectFit: "cover",
        objectPosition: "42% 58%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 144,
        y: 41,
        width: 116,
        height: 68,
        fontSize: 22,
        color: "#332820",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "end",
        textAlign: "center"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 150,
        y: 105,
        width: 112,
        height: 86,
        fontSize: 13,
        color: "rgba(51, 40, 32, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 2,
        blockAlign: "start",
        textAlign: "center"
      },
      {
        id: "line-1",
        type: "line",
        x: 178,
        y: 164,
        length: 56,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(123, 62, 52, 0.24)",
        zIndex: 10
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "横版",
        "古琴",
        "梅枝"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 10,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 16,
          charactersPerLine: 8,
          lineCount: 2,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-square-celadon-narcissus",
    name: "青瓷水仙",
    version: 1,
    width: 290,
    height: 330,
    backgroundColor: "#fbf8f0",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/square-celadon-narcissus.jpg",
        prompt: "方形中国风笔记卡片背景，青瓷瓶与水仙位于下方偏右，左侧和上方留白，浅青瓷色与淡墨，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 330,
        objectFit: "cover",
        objectPosition: "54% 58%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 34,
        y: 56,
        width: 122,
        height: 68,
        fontSize: 22,
        color: "#263a36",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "start"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 34,
        y: 119.5,
        width: 122,
        height: 92,
        fontSize: 13,
        color: "rgba(38, 58, 54, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 4,
        blockAlign: "start"
      },
      {
        id: "line-1",
        type: "line",
        x: 34,
        y: 257,
        length: 70,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(38, 58, 54, 0.22)",
        zIndex: 10
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "方形",
        "青瓷",
        "水仙"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 10,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 36,
          charactersPerLine: 9,
          lineCount: 4,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-wide-inkstone-brush",
    name: "砚边短记",
    version: 1,
    width: 290,
    height: 250,
    backgroundColor: "#fbf8f1",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/wide-inkstone-brush.jpg",
        prompt: "横版中国风笔记卡片背景，砚台与毛笔位于左下角，墨痕极淡，右侧大面积留白，淡墨灰与旧纸色，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 250,
        objectFit: "cover",
        objectPosition: "42% 56%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "quote",
        type: "text",
        role: "decoration",
        content: "“",
        x: 196,
        y: 26,
        width: 62,
        height: 70,
        fontSize: 65,
        color: "rgba(44, 41, 36, 0.08)",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 0,
        lineHeight: 1,
        maxLines: 1,
        textAlign: "left",
        blockAlign: "start"
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 127,
        y: 79,
        width: 136,
        height: 64,
        fontSize: 22,
        color: "#2c2924",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "end",
        textAlign: "right"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 127,
        y: 146,
        width: 136,
        height: 68,
        fontSize: 13,
        color: "rgba(44, 41, 36, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 3,
        blockAlign: "start",
        textAlign: "right"
      },
      {
        id: "line-1",
        type: "line",
        x: 208,
        y: 229,
        length: 56,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(44, 41, 36, 0.22)",
        zIndex: 10
      },
      {
        id: "seal",
        type: "image",
        role: "stamp",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/seal-kongshengmiaoyou.png",
        prompt: "朱文篆刻印章素材，四字为「空生妙有」，传统四字印章读法为右上空、右下生、左上妙、左下有，小篆风格，红印泥质感。",
        x: 24.14300537109375,
        y: 22,
        width: 30,
        height: 30,
        objectFit: "contain",
        objectPosition: "50% 50%",
        opacity: 0.9,
        shape: "rectangle",
        zIndex: 24
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "横版",
        "砚台",
        "毛笔"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 10,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 30,
          charactersPerLine: 10,
          lineCount: 3,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-wide-scroll-orchid",
    name: "卷轴兰风",
    version: 1,
    width: 290,
    height: 250,
    backgroundColor: "#fbf8ef",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/wide-scroll-orchid.jpg",
        prompt: "横版中国风笔记卡片背景，空白卷轴与兰叶位于下方偏左，右上留白，米白宣纸与浅青绿，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 250,
        objectFit: "cover",
        objectPosition: "44% 58%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 148,
        y: 39,
        width: 120,
        height: 68,
        fontSize: 22,
        color: "#273832",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "end"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 150,
        y: 108,
        width: 110,
        height: 88,
        fontSize: 13,
        color: "rgba(39, 56, 50, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 4,
        blockAlign: "start"
      },
      {
        id: "line-1",
        type: "line",
        x: 150,
        y: 218,
        length: 60,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(39, 56, 50, 0.22)",
        zIndex: 10
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "横版",
        "卷轴",
        "兰叶"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 10,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 32,
          charactersPerLine: 8,
          lineCount: 4,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-tall-white-magnolia",
    name: "玉兰素笺",
    version: 1,
    width: 290,
    height: 455,
    backgroundColor: "#fbf8f1",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/tall-white-magnolia.jpg",
        prompt: "竖版中国风笔记卡片背景，白玉兰枝从左上伸入，右侧与下方大面积留白，暖白、浅灰绿和淡墨，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 455,
        objectFit: "cover",
        objectPosition: "44% 44%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 200,
        y: 70,
        width: 58,
        height: 268,
        fontSize: 22,
        color: "#2d3a35",
        direction: "vertical",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 1,
        blockAlign: "start"
      },
      {
        id: "seal",
        type: "image",
        role: "stamp",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/seal-kongshengmiaoyou.png",
        prompt: "朱文篆刻印章素材，四字为「空生妙有」，传统四字印章读法为右上空、右下生、左上妙、左下有，小篆风格，红印泥质感。",
        x: 229,
        y: 372,
        width: 30,
        height: 30,
        objectFit: "contain",
        objectPosition: "50% 50%",
        opacity: 0.9,
        shape: "rectangle",
        zIndex: 24
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "竖版",
        "玉兰",
        "竖排"
      ],
      requiresImage: !1,
      preferVerticalText: !0,
      maxTitleLength: 11,
      weight: 11,
      textCapacity: {
        title: {
          direction: "vertical",
          maxCharacters: 11,
          charactersPerColumn: 11,
          columnCount: 1,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        }
      }
    }
  },
  {
    id: "curated-square-pomegranate-branch",
    name: "榴枝小记",
    version: 1,
    width: 290,
    height: 330,
    backgroundColor: "#fbf7ef",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/square-pomegranate-branch.jpg",
        prompt: "方形中国风笔记卡片背景，石榴枝从右下伸入，左上留白，低饱和胭脂红点睛，国画淡彩，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 330,
        objectFit: "cover",
        objectPosition: "56% 58%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 33,
        y: 58,
        width: 124,
        height: 68,
        fontSize: 22,
        color: "#4a2b22",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "end"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 34,
        y: 130,
        width: 124,
        height: 92,
        fontSize: 13,
        color: "rgba(74, 43, 34, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 4,
        blockAlign: "start"
      },
      {
        id: "line-1",
        type: "line",
        x: 34,
        y: 280,
        length: 70,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(150, 65, 52, 0.25)",
        zIndex: 10
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "方形",
        "石榴",
        "淡红"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 10,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 36,
          charactersPerLine: 9,
          lineCount: 4,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-wide-geese-reed",
    name: "雁过芦汀",
    version: 1,
    width: 290,
    height: 260,
    backgroundColor: "#fbf8f0",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/wide-geese-reed.jpg",
        prompt: "横版中国风笔记卡片背景，飞雁剪影与右下芦苇，中央和左侧留白，淡墨灰与浅赭色，宣纸底，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 260,
        objectFit: "cover",
        objectPosition: "58% 58%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 32,
        y: 29,
        width: 122,
        height: 68,
        fontSize: 22,
        color: "#30332e",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "end"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 34,
        y: 97,
        width: 122,
        height: 86,
        fontSize: 13,
        color: "rgba(48, 51, 46, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 4,
        blockAlign: "start"
      },
      {
        id: "line-1",
        type: "line",
        x: 34,
        y: 202,
        length: 64,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(48, 51, 46, 0.22)",
        zIndex: 10
      },
      {
        id: "seal",
        type: "image",
        role: "stamp",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/seal-kongshengmiaoyou.png",
        prompt: "朱文篆刻印章素材，四字为「空生妙有」，传统四字印章读法为右上空、右下生、左上妙、左下有，小篆风格，红印泥质感。",
        x: 234.8570556640625,
        y: 22,
        width: 30,
        height: 30,
        objectFit: "contain",
        objectPosition: "50% 50%",
        opacity: 0.9,
        shape: "rectangle",
        zIndex: 24
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "横版",
        "飞雁",
        "芦苇"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 10,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 36,
          charactersPerLine: 9,
          lineCount: 4,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-square-paper-umbrella",
    name: "伞边雨痕",
    version: 1,
    width: 290,
    height: 330,
    backgroundColor: "#fbf8f1",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/square-paper-umbrella.jpg",
        prompt: "方形中国风笔记卡片背景，油纸伞局部弧形位于左下角，雨痕极淡，右上大面积留白，浅杏白与淡赭，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 330,
        objectFit: "cover",
        objectPosition: "42% 56%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 138,
        y: 25,
        width: 120,
        height: 68,
        fontSize: 22,
        color: "#3e3026",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "end",
        textAlign: "right"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 76,
        y: 95,
        width: 180,
        height: 92,
        fontSize: 13,
        color: "rgba(62, 48, 38, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 3,
        blockAlign: "start",
        textAlign: "right"
      },
      {
        id: "line-1",
        type: "line",
        x: 207,
        y: 183.1429443359375,
        length: 52,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(62, 48, 38, 0.22)",
        zIndex: 10
      },
      {
        id: "seal",
        type: "image",
        role: "stamp",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/seal-kongshengmiaoyou.png",
        prompt: "朱文篆刻印章素材，四字为「空生妙有」，传统四字印章读法为右上空、右下生、左上妙、左下有，小篆风格，红印泥质感。",
        x: 27.71429443359375,
        y: 28,
        width: 30,
        height: 30,
        objectFit: "contain",
        objectPosition: "50% 50%",
        opacity: 0.9,
        shape: "rectangle",
        zIndex: 24
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "方形",
        "纸伞",
        "雨痕"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 10,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 39,
          charactersPerLine: 13,
          lineCount: 3,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-tall-round-fan-bamboo",
    name: "团扇竹风",
    version: 1,
    width: 290,
    height: 455,
    backgroundColor: "#fbf8ef",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/tall-round-fan-bamboo.jpg",
        prompt: "竖版中国风笔记卡片背景，素色团扇与竹叶位于右下角，左上留白，米白、浅青灰与淡墨，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 455,
        objectFit: "cover",
        objectPosition: "58% 58%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "quote",
        type: "text",
        role: "decoration",
        content: "“",
        x: -7,
        y: 100,
        width: 74,
        height: 82,
        fontSize: 64,
        color: "rgba(39, 56, 50, 0.08)",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 0,
        lineHeight: 1,
        maxLines: 1,
        textAlign: "left",
        blockAlign: "start"
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 24,
        y: 138,
        width: 136,
        height: 68,
        fontSize: 22,
        color: "#273832",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "end"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 26,
        y: 208,
        width: 136,
        height: 92,
        fontSize: 13,
        color: "rgba(39, 56, 50, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 4,
        blockAlign: "start"
      },
      {
        id: "line-1",
        type: "line",
        x: 26,
        y: 317.4285888671875,
        length: 76,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(39, 56, 50, 0.22)",
        zIndex: 10
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "竖版",
        "团扇",
        "竹叶"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 10,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 40,
          charactersPerLine: 10,
          lineCount: 4,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-wide-pine-stone",
    name: "松石远意",
    version: 1,
    width: 290,
    height: 260,
    backgroundColor: "#fbf8ef",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/wide-pine-stone.jpg",
        prompt: "横版中国风笔记卡片背景，松针与山石位于左下角，远山极淡，右上留白，淡墨灰、松青与浅赭，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 260,
        objectFit: "cover",
        objectPosition: "42% 58%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 143,
        y: 32,
        width: 120,
        height: 68,
        fontSize: 22,
        color: "#29362f",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "end"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 125,
        y: 106,
        width: 132,
        height: 86,
        fontSize: 13,
        color: "rgba(41, 54, 47, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 4,
        blockAlign: "start",
        textAlign: "right"
      },
      {
        id: "line-1",
        type: "line",
        x: 200,
        y: 214,
        length: 60,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(41, 54, 47, 0.22)",
        zIndex: 10
      },
      {
        id: "seal",
        type: "image",
        role: "stamp",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/seal-kongshengmiaoyou.png",
        prompt: "朱文篆刻印章素材，四字为「空生妙有」，传统四字印章读法为右上空、右下生、左上妙、左下有，小篆风格，红印泥质感。",
        x: 22,
        y: 18,
        width: 30,
        height: 30,
        objectFit: "contain",
        objectPosition: "50% 50%",
        opacity: 0.9,
        shape: "rectangle",
        zIndex: 24
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "横版",
        "松针",
        "山石"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 10,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 40,
          charactersPerLine: 10,
          lineCount: 4,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-tall-loquat-branch",
    name: "枇杷清黄",
    version: 1,
    width: 290,
    height: 455,
    backgroundColor: "#fbf8f0",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/tall-loquat-branch.jpg",
        prompt: "竖版中国风笔记卡片背景，枇杷枝从右侧伸入，左侧与上方留白，浅金黄、青灰绿与淡墨，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 455,
        objectFit: "cover",
        objectPosition: "58% 52%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 38.5,
        y: 72,
        width: 58,
        height: 284,
        fontSize: 22,
        color: "#3d3a22",
        direction: "vertical",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 1,
        blockAlign: "end"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 65,
        y: 72,
        width: 58,
        height: 216,
        fontSize: 13,
        color: "rgba(61, 58, 34, 0.62)",
        direction: "vertical",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.55,
        maxLines: 2,
        blockAlign: "start"
      },
      {
        id: "seal",
        type: "image",
        role: "stamp",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/seal-kongshengmiaoyou.png",
        prompt: "朱文篆刻印章素材，四字为「空生妙有」，传统四字印章读法为右上空、右下生、左上妙、左下有，小篆风格，红印泥质感。",
        x: 46.5,
        y: 383,
        width: 30,
        height: 30,
        objectFit: "contain",
        objectPosition: "50% 50%",
        opacity: 0.9,
        shape: "rectangle",
        zIndex: 24
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "竖版",
        "枇杷",
        "双列"
      ],
      requiresImage: !1,
      preferVerticalText: !0,
      maxTitleLength: 12,
      weight: 10,
      textCapacity: {
        title: {
          direction: "vertical",
          maxCharacters: 12,
          charactersPerColumn: 12,
          columnCount: 1,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "vertical",
          maxCharacters: 32,
          charactersPerColumn: 16,
          columnCount: 2,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.55
        }
      }
    }
  },
  {
    id: "curated-wide-deer-bamboo-fence",
    name: "鹿过竹篱",
    version: 1,
    width: 290,
    height: 260,
    backgroundColor: "#fbf8ef",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/wide-deer-bamboo-fence.jpg",
        prompt: "横版中国风笔记卡片背景，水墨化小鹿与竹篱位于左下角，右侧和上方留白，淡赭、青灰绿与淡墨，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 260,
        objectFit: "cover",
        objectPosition: "42% 58%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 149,
        y: 36,
        width: 124,
        height: 68,
        fontSize: 22,
        color: "#3a3026",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "end"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 150,
        y: 110,
        width: 110,
        height: 86,
        fontSize: 13,
        color: "rgba(58, 48, 38, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 4,
        blockAlign: "start"
      },
      {
        id: "line-1",
        type: "line",
        x: 150,
        y: 226,
        length: 58,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(58, 48, 38, 0.22)",
        zIndex: 10
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "横版",
        "小鹿",
        "竹篱"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 10,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 32,
          charactersPerLine: 8,
          lineCount: 4,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-wide-roof-cat",
    name: "瓦猫守檐",
    version: 1,
    width: 290,
    height: 240,
    backgroundColor: "#fbf8f0",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/wide-roof-cat.jpg",
        prompt: "横版中国风笔记卡片背景，瓦猫与屋脊位于左上边缘，右侧和下方留白，旧瓦青、淡墨灰与米白，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 240,
        objectFit: "cover",
        objectPosition: "42% 44%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 142,
        y: 44,
        width: 116,
        height: 66,
        fontSize: 22,
        color: "#2d302c",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "start",
        textAlign: "right"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 142,
        y: 106,
        width: 116,
        height: 76,
        fontSize: 13,
        color: "rgba(45, 48, 44, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 3,
        blockAlign: "start",
        textAlign: "right"
      },
      {
        id: "line-1",
        type: "line",
        x: 206,
        y: 206,
        length: 52,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(45, 48, 44, 0.22)",
        zIndex: 10
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "横版",
        "瓦猫",
        "屋脊"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 10,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 24,
          charactersPerLine: 8,
          lineCount: 3,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-square-lotus-root",
    name: "藕痕清水",
    version: 1,
    width: 290,
    height: 330,
    backgroundColor: "#fbf8f0",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/square-lotus-root.jpg",
        prompt: "方形中国风笔记卡片背景，莲藕与小荷叶位于下方偏右，左上留白，浅青灰与淡墨，非写实国画感，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 330,
        objectFit: "cover",
        objectPosition: "54% 58%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 34,
        y: 58,
        width: 124,
        height: 68,
        fontSize: 22,
        color: "#2d3b36",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "start"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 34,
        y: 126,
        width: 124,
        height: 92,
        fontSize: 13,
        color: "rgba(45, 59, 54, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 4,
        blockAlign: "start"
      },
      {
        id: "line-1",
        type: "line",
        x: 34,
        y: 280,
        length: 70,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(45, 59, 54, 0.22)",
        zIndex: 10
      },
      {
        id: "seal",
        type: "image",
        role: "stamp",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/seal-kongshengmiaoyou.png",
        prompt: "朱文篆刻印章素材，四字为「空生妙有」，传统四字印章读法为右上空、右下生、左上妙、左下有，小篆风格，红印泥质感。",
        x: 235.71417236328125,
        y: 28,
        width: 30,
        height: 30,
        objectFit: "contain",
        objectPosition: "50% 50%",
        opacity: 0.9,
        shape: "rectangle",
        zIndex: 24
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "方形",
        "莲藕",
        "水波"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 10,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 36,
          charactersPerLine: 9,
          lineCount: 4,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-tall-coin-grass",
    name: "铜钱草露",
    version: 1,
    width: 290,
    height: 455,
    backgroundColor: "#fbf8f0",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/tall-coin-grass.jpg",
        prompt: "竖版中国风笔记卡片背景，铜钱草与清水波纹位于左下角，右侧大面积留白，浅青绿、淡墨、米白，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 455,
        objectFit: "cover",
        objectPosition: "42% 58%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 143,
        y: 55.85711669921875,
        width: 118,
        height: 68,
        fontSize: 22,
        color: "#263c32",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "end",
        textAlign: "right"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 140,
        y: 132,
        width: 120,
        height: 92,
        fontSize: 13,
        color: "rgba(38, 60, 50, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 4,
        blockAlign: "start",
        textAlign: "right"
      },
      {
        id: "seal",
        type: "image",
        role: "stamp",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/seal-kongshengmiaoyou.png",
        prompt: "朱文篆刻印章素材，四字为「空生妙有」，传统四字印章读法为右上空、右下生、左上妙、左下有，小篆风格，红印泥质感。",
        x: 238,
        y: 388,
        width: 30,
        height: 30,
        objectFit: "contain",
        objectPosition: "50% 50%",
        opacity: 0.9,
        shape: "rectangle",
        zIndex: 24
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "竖版",
        "铜钱草",
        "青绿"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 10,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 36,
          charactersPerLine: 9,
          lineCount: 4,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-wide-leaping-koi",
    name: "跃鲤水纹",
    version: 1,
    width: 290,
    height: 260,
    backgroundColor: "#fbf8ef",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/wide-leaping-koi.jpg",
        prompt: "横版中国风笔记卡片背景，一条写意鲤鱼从右下水面轻跃，左侧和上方留白，浅青水色和少量朱橘，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 260,
        objectFit: "cover",
        objectPosition: "58% 58%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 34,
        y: 48,
        width: 122,
        height: 68,
        fontSize: 22,
        color: "#26343a",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "start"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 34,
        y: 114,
        width: 122,
        height: 86,
        fontSize: 13,
        color: "rgba(38, 52, 58, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 4,
        blockAlign: "start"
      },
      {
        id: "line-1",
        type: "line",
        x: 34,
        y: 226,
        length: 66,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(154, 70, 46, 0.24)",
        zIndex: 10
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "横版",
        "鲤鱼",
        "水纹"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 10,
      weight: 10,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 10,
          charactersPerLine: 5,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 36,
          charactersPerLine: 9,
          lineCount: 4,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-square-tea-cup-branch",
    name: "白瓷茶枝",
    version: 1,
    width: 290,
    height: 330,
    backgroundColor: "#fbf8f0",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/square-tea-cup-branch.jpg",
        prompt: "方形中国风笔记卡片背景，白瓷杯与茶枝位于左下角，右侧和上方留白，浅茶褐、淡青绿、淡墨，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 330,
        objectFit: "cover",
        objectPosition: "44% 58%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 148,
        y: 58,
        width: 110,
        height: 68,
        fontSize: 22,
        color: "#303829",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "start",
        textAlign: "right"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 146,
        y: 126,
        width: 112,
        height: 92,
        fontSize: 13,
        color: "rgba(48, 56, 41, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 4,
        blockAlign: "start",
        textAlign: "right"
      },
      {
        id: "line-1",
        type: "line",
        x: 206,
        y: 280,
        length: 52,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(48, 56, 41, 0.22)",
        zIndex: 10
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "方形",
        "茶杯",
        "茶枝"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 8,
      weight: 10,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 8,
          charactersPerLine: 4,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 32,
          charactersPerLine: 8,
          lineCount: 4,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  },
  {
    id: "curated-wide-red-plum-snow",
    name: "雪梅横枝",
    version: 1,
    width: 290,
    height: 260,
    backgroundColor: "#fbf8f1",
    borderRadius: "8px",
    elements: [
      {
        id: "background",
        type: "image",
        role: "background",
        source: "static",
        staticUrl: "/chinese-masonry-assets/curated-backgrounds/wide-red-plum-snow.jpg",
        prompt: "横版中国风笔记卡片背景，雪中红梅枝从左侧伸入，右侧大面积留白，低饱和胭脂红与淡墨枝干，无文字。",
        x: 0,
        y: 0,
        width: 290,
        height: 260,
        objectFit: "cover",
        objectPosition: "42% 48%",
        opacity: 1,
        shape: "rectangle",
        zIndex: 0
      },
      {
        id: "quote",
        type: "text",
        role: "decoration",
        content: "“",
        x: 198,
        y: 28,
        width: 60,
        height: 68,
        fontSize: 68,
        color: "rgba(135, 46, 45, 0.08)",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 0,
        lineHeight: 1,
        maxLines: 1,
        textAlign: "left",
        blockAlign: "start"
      },
      {
        id: "title",
        type: "text",
        role: "title",
        x: 146,
        y: 88,
        width: 112,
        height: 64,
        fontSize: 22,
        color: "#3a2523",
        direction: "horizontal",
        fontWeight: "bold",
        letterSpacing: 1,
        lineHeight: 1.35,
        maxLines: 2,
        blockAlign: "start",
        textAlign: "right"
      },
      {
        id: "desc",
        type: "text",
        role: "description",
        x: 146,
        y: 150,
        width: 112,
        height: 70,
        fontSize: 13,
        color: "rgba(58, 37, 35, 0.62)",
        direction: "horizontal",
        fontWeight: "normal",
        letterSpacing: 0,
        lineHeight: 1.75,
        maxLines: 3,
        blockAlign: "start",
        textAlign: "right"
      },
      {
        id: "line-1",
        type: "line",
        x: 202,
        y: 230,
        length: 56,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(135, 46, 45, 0.24)",
        zIndex: 10
      }
    ],
    meta: {
      category: "国画底纹",
      tags: [
        "国画底纹",
        "宣纸",
        "留白",
        "横版",
        "红梅",
        "雪意"
      ],
      requiresImage: !1,
      preferVerticalText: !1,
      maxTitleLength: 8,
      weight: 10,
      textCapacity: {
        title: {
          direction: "horizontal",
          maxCharacters: 8,
          charactersPerLine: 4,
          lineCount: 2,
          fontSize: 22,
          letterSpacing: 1,
          lineHeight: 1.35
        },
        description: {
          direction: "horizontal",
          maxCharacters: 24,
          charactersPerLine: 8,
          lineCount: 3,
          fontSize: 13,
          letterSpacing: 0,
          lineHeight: 1.75
        }
      }
    }
  }
], le = Dn, oa = le[0], aa = le[1], ca = le[2];
class Tn {
  constructor(t = []) {
    Be(this, "templates", /* @__PURE__ */ new Map());
    Be(this, "lazyLoaders", /* @__PURE__ */ new Map());
    Be(this, "loading", /* @__PURE__ */ new Map());
    t.forEach((i) => this.register(i));
  }
  register(t) {
    this.templates.set(t.id, t), this.lazyLoaders.delete(t.id), this.loading.delete(t.id);
  }
  registerLazy(t, i) {
    this.templates.has(t) || this.lazyLoaders.set(t, i);
  }
  get(t) {
    return this.templates.get(t);
  }
  async load(t) {
    const i = this.templates.get(t);
    if (i) return i;
    const r = this.loading.get(t);
    if (r) return r;
    const n = this.lazyLoaders.get(t);
    if (!n)
      throw new Error(`Template "${t}" is not registered.`);
    const o = n().then((a) => (this.register(a), a));
    return this.loading.set(t, o), o;
  }
  getAll() {
    return Array.from(this.templates.values());
  }
  getByCategory(t) {
    return this.getAll().filter((i) => i.meta.category === t);
  }
  remove(t) {
    return this.lazyLoaders.delete(t), this.loading.delete(t), this.templates.delete(t);
  }
}
function Yn() {
  return new Tn(le);
}
function Fn(e, t) {
  return !Number.isFinite(e) || e === void 0 ? t : Math.max(1, Math.floor(e));
}
function hi(e) {
  const t = Math.max(1, e.fontSize), i = e.letterSpacing ?? 0, r = e.lineHeight ?? 1.6, n = Math.max(1, t + i), o = Fn(e.maxLines, 1);
  if (e.direction === "vertical") {
    const c = Math.max(1, Math.floor(e.height / n));
    return {
      direction: "vertical",
      maxCharacters: c * o,
      charactersPerColumn: c,
      columnCount: o,
      fontSize: t,
      letterSpacing: i,
      lineHeight: r
    };
  }
  const a = Math.max(1, Math.floor(e.width / n));
  return {
    direction: "horizontal",
    maxCharacters: a * o,
    charactersPerLine: a,
    lineCount: o,
    fontSize: t,
    letterSpacing: i,
    lineHeight: r
  };
}
function Ht(e) {
  const t = {}, i = e.elements.find(
    (n) => n.type === "text" && n.role === "title"
  ), r = e.elements.find(
    (n) => n.type === "text" && n.role === "description"
  );
  return i && (t.title = hi(i)), r && (t.description = hi(r)), t;
}
function oe(e) {
  var i;
  const t = Ht(e);
  return {
    ...e,
    meta: {
      ...e.meta,
      maxTitleLength: ((i = t.title) == null ? void 0 : i.maxCharacters) ?? e.meta.maxTitleLength,
      textCapacity: t
    }
  };
}
function Mn(e, t = {}) {
  const i = t.random ?? Math.random, r = t.allowFallback ?? !0, n = t.templateFilter;
  function o(c, u) {
    var p, C;
    const l = c.title.trim().length, s = ((p = c.description) == null ? void 0 : p.trim().length) ?? 0, f = Qn(c.title), h = u.meta.textCapacity ?? Ht(u);
    let d = Math.max(0.1, u.meta.weight);
    if (u.meta.minTitleLength && l < u.meta.minTitleLength || h.title && l > h.title.maxCharacters || u.meta.maxTitleLength && l > u.meta.maxTitleLength || u.meta.requiresImage && !c.imageUrl) return 0;
    const g = u.elements.some(
      (w) => w.type === "image" && w.source === "dynamic"
    );
    return c.imageUrl && g && (d *= 1.4), u.meta.preferVerticalText ? (d *= f ? 2.4 : 0.3, l <= 6 && (d *= 1.8)) : l <= 6 && (d *= 1.15), l > 12 && !u.meta.preferVerticalText && (d *= 1.35), h.title && l <= h.title.maxCharacters * 0.65 && (d *= 1.08), h.description && s > 0 && (s <= h.description.maxCharacters ? d *= 1.08 : d *= Math.max(0.35, h.description.maxCharacters / s)), c.category && c.category === u.meta.category && (d *= 1.3), (C = c.tags) != null && C.some((w) => u.meta.tags.includes(w)) && (d *= 1.2), Number(d.toFixed(4));
  }
  function a(c, u = {}) {
    const l = /* @__PURE__ */ new Set([
      ...t.excludeTemplateIds ?? [],
      ...u.excludeTemplateIds ?? []
    ]), s = e.getAll(), f = s.map((w) => ({ template: w, score: o(c, w) })).filter((w) => w.score > 0), h = n ? f.filter((w) => n(c, w.template)) : f, d = h.filter((w) => !l.has(w.template.id));
    let g = d.length > 0 ? d : r ? h : [];
    if (g.length === 0 && r && s.length > 0) {
      const w = s.filter((x) => !n || n(c, x)).map((x) => {
        var L, b;
        const y = ((b = (L = x.meta.textCapacity) == null ? void 0 : L.title) == null ? void 0 : b.maxCharacters) ?? x.meta.maxTitleLength ?? 0;
        return { template: x, score: y };
      }).sort((x, y) => y.score - x.score);
      g = (w.length > 0 ? w : s.map((x) => {
        var L, b;
        const y = ((b = (L = x.meta.textCapacity) == null ? void 0 : L.title) == null ? void 0 : b.maxCharacters) ?? x.meta.maxTitleLength ?? 0;
        return { template: x, score: y };
      }).sort((x, y) => y.score - x.score)).slice(0, 10);
    }
    if (g.length === 0)
      throw new Error("No template can render this article.");
    const p = g.reduce((w, z) => w + z.score, 0);
    let C = i() * p;
    for (const w of g)
      if (C -= w.score, C <= 0) return w.template;
    return g[g.length - 1].template;
  }
  return { select: a, score: o };
}
function sa({
  items: e,
  columnGutter: t = Xi,
  rowGutter: i = Pn,
  registry: r,
  selectorOptions: n,
  templateId: o,
  fontConfig: a,
  colorConfig: c,
  onItemClick: u,
  className: l,
  style: s
}) {
  const f = Y(null), [h, d] = G(0), g = ue(() => r ?? Yn(), [r]), p = ue(
    () => Mn(g, n),
    [g, n]
  ), C = ue(() => {
    let x;
    return e.map((y) => {
      const b = (o ? g.get(o) : void 0) ?? p.select(y, x ? { excludeTemplateIds: [x] } : void 0);
      return x = b.id, { article: y, template: b };
    });
  }, [g, e, p, o]);
  W(() => {
    const x = f.current;
    if (!x) return;
    const y = (b) => {
      d(Math.max(0, Math.floor(b)));
    };
    y(x.getBoundingClientRect().width);
    const L = new ResizeObserver((b) => {
      const [m] = b;
      y(m.contentRect.width);
    });
    return L.observe(x), () => L.disconnect();
  }, []);
  const w = N * 3 + t * 2, z = Hn(h || w, t);
  return e.length === 0 ? /* @__PURE__ */ A("div", { className: `cm-empty ${l ?? ""}`, children: "暂无文章" }) : /* @__PURE__ */ A(
    "div",
    {
      ref: f,
      className: `cm-masonry-root ${l ?? ""}`,
      style: {
        width: "100%",
        overflowX: "auto",
        ...s
      },
      children: /* @__PURE__ */ A(
        "div",
        {
          className: "cm-masonry-grid",
          style: {
            width: z.gridWidth,
            marginInline: "auto"
          },
          children: /* @__PURE__ */ A(
            Ui,
            {
              items: C,
              columnWidth: N,
              columnGutter: t,
              rowGutter: i,
              itemKey: (x) => x.article.id,
              render: ({ data: x }) => /* @__PURE__ */ A(
                _i,
                {
                  article: x.article,
                  template: x.template,
                  fontConfig: a,
                  colorConfig: c,
                  onClick: u
                }
              )
            }
          )
        }
      )
    }
  );
}
function ot({ event: e, onStart: t, onMove: i, onEnd: r }) {
  e.preventDefault(), e.stopPropagation();
  const n = (h) => Number.isFinite(h) ? h : 0, o = n(e.clientX), a = n(e.clientY);
  let c = o, u = a, l = !1;
  const s = (h) => {
    const d = n(h.clientX), g = n(h.clientY), p = d - c, C = g - u;
    p === 0 && C === 0 || (l || (t == null || t(), l = !0), c = d, u = g, i(p, C));
  }, f = () => {
    window.removeEventListener("pointermove", s), window.removeEventListener("pointerup", f), r == null || r();
  };
  window.addEventListener("pointermove", s), window.addEventListener("pointerup", f, { once: !0 });
}
const Wn = {}, gi = (e) => {
  let t;
  const i = /* @__PURE__ */ new Set(), r = (s, f) => {
    const h = typeof s == "function" ? s(t) : s;
    if (!Object.is(h, t)) {
      const d = t;
      t = f ?? (typeof h != "object" || h === null) ? h : Object.assign({}, t, h), i.forEach((g) => g(t, d));
    }
  }, n = () => t, u = { setState: r, getState: n, getInitialState: () => l, subscribe: (s) => (i.add(s), () => i.delete(s)), destroy: () => {
    (Wn ? "production" : void 0) !== "production" && console.warn(
      "[DEPRECATED] The `destroy` method will be unsupported in a future version. Instead use unsubscribe function returned by subscribe. Everything will be garbage-collected if store is garbage-collected."
    ), i.clear();
  } }, l = t = e(r, n, u);
  return u;
}, Nn = (e) => e ? gi(e) : gi;
function Kn(e) {
  return e && e.__esModule && Object.prototype.hasOwnProperty.call(e, "default") ? e.default : e;
}
var xt = { exports: {} }, at = {}, je = { exports: {} }, ct = {};
/**
 * @license React
 * use-sync-external-store-shim.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
var di;
function Jn() {
  if (di) return ct;
  di = 1;
  var e = B;
  function t(f, h) {
    return f === h && (f !== 0 || 1 / f === 1 / h) || f !== f && h !== h;
  }
  var i = typeof Object.is == "function" ? Object.is : t, r = e.useState, n = e.useEffect, o = e.useLayoutEffect, a = e.useDebugValue;
  function c(f, h) {
    var d = h(), g = r({ inst: { value: d, getSnapshot: h } }), p = g[0].inst, C = g[1];
    return o(
      function() {
        p.value = d, p.getSnapshot = h, u(p) && C({ inst: p });
      },
      [f, d, h]
    ), n(
      function() {
        return u(p) && C({ inst: p }), f(function() {
          u(p) && C({ inst: p });
        });
      },
      [f]
    ), a(d), d;
  }
  function u(f) {
    var h = f.getSnapshot;
    f = f.value;
    try {
      var d = h();
      return !i(f, d);
    } catch {
      return !0;
    }
  }
  function l(f, h) {
    return h();
  }
  var s = typeof window > "u" || typeof window.document > "u" || typeof window.document.createElement > "u" ? l : c;
  return ct.useSyncExternalStore = e.useSyncExternalStore !== void 0 ? e.useSyncExternalStore : s, ct;
}
var st = {};
/**
 * @license React
 * use-sync-external-store-shim.development.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
var ui;
function Gn() {
  return ui || (ui = 1, process.env.NODE_ENV !== "production" && function() {
    function e(d, g) {
      return d === g && (d !== 0 || 1 / d === 1 / g) || d !== d && g !== g;
    }
    function t(d, g) {
      s || n.startTransition === void 0 || (s = !0, console.error(
        "You are using an outdated, pre-release alpha of React 18 that does not support useSyncExternalStore. The use-sync-external-store shim will not work correctly. Upgrade to a newer pre-release."
      ));
      var p = g();
      if (!f) {
        var C = g();
        o(p, C) || (console.error(
          "The result of getSnapshot should be cached to avoid an infinite loop"
        ), f = !0);
      }
      C = a({
        inst: { value: p, getSnapshot: g }
      });
      var w = C[0].inst, z = C[1];
      return u(
        function() {
          w.value = p, w.getSnapshot = g, i(w) && z({ inst: w });
        },
        [d, p, g]
      ), c(
        function() {
          return i(w) && z({ inst: w }), d(function() {
            i(w) && z({ inst: w });
          });
        },
        [d]
      ), l(p), p;
    }
    function i(d) {
      var g = d.getSnapshot;
      d = d.value;
      try {
        var p = g();
        return !o(d, p);
      } catch {
        return !0;
      }
    }
    function r(d, g) {
      return g();
    }
    typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ < "u" && typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStart == "function" && __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStart(Error());
    var n = B, o = typeof Object.is == "function" ? Object.is : e, a = n.useState, c = n.useEffect, u = n.useLayoutEffect, l = n.useDebugValue, s = !1, f = !1, h = typeof window > "u" || typeof window.document > "u" || typeof window.document.createElement > "u" ? r : t;
    st.useSyncExternalStore = n.useSyncExternalStore !== void 0 ? n.useSyncExternalStore : h, typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ < "u" && typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStop == "function" && __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStop(Error());
  }()), st;
}
var fi;
function $i() {
  return fi || (fi = 1, process.env.NODE_ENV === "production" ? je.exports = Jn() : je.exports = Gn()), je.exports;
}
/**
 * @license React
 * use-sync-external-store-shim/with-selector.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
var Ai;
function Un() {
  if (Ai) return at;
  Ai = 1;
  var e = B, t = $i();
  function i(l, s) {
    return l === s && (l !== 0 || 1 / l === 1 / s) || l !== l && s !== s;
  }
  var r = typeof Object.is == "function" ? Object.is : i, n = t.useSyncExternalStore, o = e.useRef, a = e.useEffect, c = e.useMemo, u = e.useDebugValue;
  return at.useSyncExternalStoreWithSelector = function(l, s, f, h, d) {
    var g = o(null);
    if (g.current === null) {
      var p = { hasValue: !1, value: null };
      g.current = p;
    } else p = g.current;
    g = c(
      function() {
        function w(b) {
          if (!z) {
            if (z = !0, x = b, b = h(b), d !== void 0 && p.hasValue) {
              var m = p.value;
              if (d(m, b))
                return y = m;
            }
            return y = b;
          }
          if (m = y, r(x, b)) return m;
          var H = h(b);
          return d !== void 0 && d(m, H) ? (x = b, m) : (x = b, y = H);
        }
        var z = !1, x, y, L = f === void 0 ? null : f;
        return [
          function() {
            return w(s());
          },
          L === null ? void 0 : function() {
            return w(L());
          }
        ];
      },
      [s, f, h, d]
    );
    var C = n(l, g[0], g[1]);
    return a(
      function() {
        p.hasValue = !0, p.value = C;
      },
      [C]
    ), u(C), C;
  }, at;
}
var lt = {};
/**
 * @license React
 * use-sync-external-store-shim/with-selector.development.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
var pi;
function Xn() {
  return pi || (pi = 1, process.env.NODE_ENV !== "production" && function() {
    function e(l, s) {
      return l === s && (l !== 0 || 1 / l === 1 / s) || l !== l && s !== s;
    }
    typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ < "u" && typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStart == "function" && __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStart(Error());
    var t = B, i = $i(), r = typeof Object.is == "function" ? Object.is : e, n = i.useSyncExternalStore, o = t.useRef, a = t.useEffect, c = t.useMemo, u = t.useDebugValue;
    lt.useSyncExternalStoreWithSelector = function(l, s, f, h, d) {
      var g = o(null);
      if (g.current === null) {
        var p = { hasValue: !1, value: null };
        g.current = p;
      } else p = g.current;
      g = c(
        function() {
          function w(b) {
            if (!z) {
              if (z = !0, x = b, b = h(b), d !== void 0 && p.hasValue) {
                var m = p.value;
                if (d(m, b))
                  return y = m;
              }
              return y = b;
            }
            if (m = y, r(x, b))
              return m;
            var H = h(b);
            return d !== void 0 && d(m, H) ? (x = b, m) : (x = b, y = H);
          }
          var z = !1, x, y, L = f === void 0 ? null : f;
          return [
            function() {
              return w(s());
            },
            L === null ? void 0 : function() {
              return w(L());
            }
          ];
        },
        [s, f, h, d]
      );
      var C = n(l, g[0], g[1]);
      return a(
        function() {
          p.hasValue = !0, p.value = C;
        },
        [C]
      ), u(C), C;
    }, typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ < "u" && typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStop == "function" && __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStop(Error());
  }()), lt;
}
process.env.NODE_ENV === "production" ? xt.exports = Un() : xt.exports = Xn();
var Zn = xt.exports;
const Vn = /* @__PURE__ */ Kn(Zn), er = {}, { useDebugValue: qn } = B, { useSyncExternalStoreWithSelector: _n } = Vn;
let mi = !1;
const $n = (e) => e;
function eo(e, t = $n, i) {
  (er ? "production" : void 0) !== "production" && i && !mi && (console.warn(
    "[DEPRECATED] Use `createWithEqualityFn` instead of `create` or use `useStoreWithEqualityFn` instead of `useStore`. They can be imported from 'zustand/traditional'. https://github.com/pmndrs/zustand/discussions/1937"
  ), mi = !0);
  const r = _n(
    e.subscribe,
    e.getState,
    e.getServerState || e.getInitialState,
    t,
    i
  );
  return qn(r), r;
}
const Ci = (e) => {
  (er ? "production" : void 0) !== "production" && typeof e != "function" && console.warn(
    "[DEPRECATED] Passing a vanilla store will be unsupported in a future version. Instead use `import { useStore } from 'zustand'`."
  );
  const t = typeof e == "function" ? Nn(e) : e, i = (r, n) => eo(t, r, n);
  return Object.assign(i, t), i;
}, to = (e) => e ? Ci(e) : Ci;
var tr = Symbol.for("immer-nothing"), xi = Symbol.for("immer-draftable"), j = Symbol.for("immer-state"), io = process.env.NODE_ENV !== "production" ? [
  // All error codes, starting by 0:
  function(e) {
    return `The plugin for '${e}' has not been loaded into Immer. To enable the plugin, import and call \`enable${e}()\` when initializing your application.`;
  },
  function(e) {
    return `produce can only be called on things that are draftable: plain objects, arrays, Map, Set or classes that are marked with '[immerable]: true'. Got '${e}'`;
  },
  "This object has been frozen and should not be mutated",
  function(e) {
    return "Cannot use a proxy that has been revoked. Did you pass an object from inside an immer function to an async process? " + e;
  },
  "An immer producer returned a new value *and* modified its draft. Either return a new value *or* modify the draft.",
  "Immer forbids circular references",
  "The first or second argument to `produce` must be a function",
  "The third argument to `produce` must be a function or undefined",
  "First argument to `createDraft` must be a plain object, an array, or an immerable object",
  "First argument to `finishDraft` must be a draft returned by `createDraft`",
  function(e) {
    return `'current' expects a draft, got: ${e}`;
  },
  "Object.defineProperty() cannot be used on an Immer draft",
  "Object.setPrototypeOf() cannot be used on an Immer draft",
  "Immer only supports deleting array indices",
  "Immer only supports setting array indices and the 'length' property",
  function(e) {
    return `'original' expects a draft, got: ${e}`;
  }
  // Note: if more errors are added, the errorOffset in Patches.ts should be increased
  // See Patches.ts for additional errors
] : [];
function k(e, ...t) {
  if (process.env.NODE_ENV !== "production") {
    const i = io[e], r = typeof i == "function" ? i.apply(null, t) : i;
    throw new Error(`[Immer] ${r}`);
  }
  throw new Error(
    `[Immer] minified error nr: ${e}. Full error at: https://bit.ly/3cXEKWf`
  );
}
var be = Object.getPrototypeOf;
function he(e) {
  return !!e && !!e[j];
}
function te(e) {
  var t;
  return e ? ir(e) || Array.isArray(e) || !!e[xi] || !!((t = e.constructor) != null && t[xi]) || Ie(e) || Ue(e) : !1;
}
var ro = Object.prototype.constructor.toString(), wi = /* @__PURE__ */ new WeakMap();
function ir(e) {
  if (!e || typeof e != "object")
    return !1;
  const t = Object.getPrototypeOf(e);
  if (t === null || t === Object.prototype)
    return !0;
  const i = Object.hasOwnProperty.call(t, "constructor") && t.constructor;
  if (i === Object)
    return !0;
  if (typeof i != "function")
    return !1;
  let r = wi.get(i);
  return r === void 0 && (r = Function.toString.call(i), wi.set(i, r)), r === ro;
}
function Me(e, t, i = !0) {
  Ge(e) === 0 ? (i ? Reflect.ownKeys(e) : Object.keys(e)).forEach((n) => {
    t(n, e[n], e);
  }) : e.forEach((r, n) => t(n, r, e));
}
function Ge(e) {
  const t = e[j];
  return t ? t.type_ : Array.isArray(e) ? 1 : Ie(e) ? 2 : Ue(e) ? 3 : 0;
}
function wt(e, t) {
  return Ge(e) === 2 ? e.has(t) : Object.prototype.hasOwnProperty.call(e, t);
}
function rr(e, t, i) {
  const r = Ge(e);
  r === 2 ? e.set(t, i) : r === 3 ? e.add(i) : e[t] = i;
}
function no(e, t) {
  return e === t ? e !== 0 || 1 / e === 1 / t : e !== e && t !== t;
}
function Ie(e) {
  return e instanceof Map;
}
function Ue(e) {
  return e instanceof Set;
}
function q(e) {
  return e.copy_ || e.base_;
}
function yt(e, t) {
  if (Ie(e))
    return new Map(e);
  if (Ue(e))
    return new Set(e);
  if (Array.isArray(e))
    return Array.prototype.slice.call(e);
  const i = ir(e);
  if (t === !0 || t === "class_only" && !i) {
    const r = Object.getOwnPropertyDescriptors(e);
    delete r[j];
    let n = Reflect.ownKeys(r);
    for (let o = 0; o < n.length; o++) {
      const a = n[o], c = r[a];
      c.writable === !1 && (c.writable = !0, c.configurable = !0), (c.get || c.set) && (r[a] = {
        configurable: !0,
        writable: !0,
        // could live with !!desc.set as well here...
        enumerable: c.enumerable,
        value: e[a]
      });
    }
    return Object.create(be(e), r);
  } else {
    const r = be(e);
    if (r !== null && i)
      return { ...e };
    const n = Object.create(r);
    return Object.assign(n, e);
  }
}
function Qt(e, t = !1) {
  return Xe(e) || he(e) || !te(e) || (Ge(e) > 1 && Object.defineProperties(e, {
    set: Re,
    add: Re,
    clear: Re,
    delete: Re
  }), Object.freeze(e), t && Object.values(e).forEach((i) => Qt(i, !0))), e;
}
function oo() {
  k(2);
}
var Re = {
  value: oo
};
function Xe(e) {
  return e === null || typeof e != "object" ? !0 : Object.isFrozen(e);
}
var ao = {};
function ie(e) {
  const t = ao[e];
  return t || k(0, e), t;
}
var ze;
function nr() {
  return ze;
}
function co(e, t) {
  return {
    drafts_: [],
    parent_: e,
    immer_: t,
    // Whenever the modified draft contains a draft from another scope, we
    // need to prevent auto-freezing so the unowned draft can be finalized.
    canAutoFreeze_: !0,
    unfinalizedDrafts_: 0
  };
}
function yi(e, t) {
  t && (ie("Patches"), e.patches_ = [], e.inversePatches_ = [], e.patchListener_ = t);
}
function bt(e) {
  zt(e), e.drafts_.forEach(so), e.drafts_ = null;
}
function zt(e) {
  e === ze && (ze = e.parent_);
}
function bi(e) {
  return ze = co(ze, e);
}
function so(e) {
  const t = e[j];
  t.type_ === 0 || t.type_ === 1 ? t.revoke_() : t.revoked_ = !0;
}
function zi(e, t) {
  t.unfinalizedDrafts_ = t.drafts_.length;
  const i = t.drafts_[0];
  return e !== void 0 && e !== i ? (i[j].modified_ && (bt(t), k(4)), te(e) && (e = We(t, e), t.parent_ || Ne(t, e)), t.patches_ && ie("Patches").generateReplacementPatches_(
    i[j].base_,
    e,
    t.patches_,
    t.inversePatches_
  )) : e = We(t, i, []), bt(t), t.patches_ && t.patchListener_(t.patches_, t.inversePatches_), e !== tr ? e : void 0;
}
function We(e, t, i) {
  if (Xe(t))
    return t;
  const r = e.immer_.shouldUseStrictIteration(), n = t[j];
  if (!n)
    return Me(
      t,
      (o, a) => Ei(e, n, t, o, a, i),
      r
    ), t;
  if (n.scope_ !== e)
    return t;
  if (!n.modified_)
    return Ne(e, n.base_, !0), n.base_;
  if (!n.finalized_) {
    n.finalized_ = !0, n.scope_.unfinalizedDrafts_--;
    const o = n.copy_;
    let a = o, c = !1;
    n.type_ === 3 && (a = new Set(o), o.clear(), c = !0), Me(
      a,
      (u, l) => Ei(
        e,
        n,
        o,
        u,
        l,
        i,
        c
      ),
      r
    ), Ne(e, o, !1), i && e.patches_ && ie("Patches").generatePatches_(
      n,
      i,
      e.patches_,
      e.inversePatches_
    );
  }
  return n.copy_;
}
function Ei(e, t, i, r, n, o, a) {
  if (n == null || typeof n != "object" && !a)
    return;
  const c = Xe(n);
  if (!(c && !a)) {
    if (process.env.NODE_ENV !== "production" && n === i && k(5), he(n)) {
      const u = o && t && t.type_ !== 3 && // Set objects are atomic since they have no keys.
      !wt(t.assigned_, r) ? o.concat(r) : void 0, l = We(e, n, u);
      if (rr(i, r, l), he(l))
        e.canAutoFreeze_ = !1;
      else
        return;
    } else a && i.add(n);
    if (te(n) && !c) {
      if (!e.immer_.autoFreeze_ && e.unfinalizedDrafts_ < 1 || t && t.base_ && t.base_[r] === n && c)
        return;
      We(e, n), (!t || !t.scope_.parent_) && typeof r != "symbol" && (Ie(i) ? i.has(r) : Object.prototype.propertyIsEnumerable.call(i, r)) && Ne(e, n);
    }
  }
}
function Ne(e, t, i = !1) {
  !e.parent_ && e.immer_.autoFreeze_ && e.canAutoFreeze_ && Qt(t, i);
}
function lo(e, t) {
  const i = Array.isArray(e), r = {
    type_: i ? 1 : 0,
    // Track which produce call this is associated with.
    scope_: t ? t.scope_ : nr(),
    // True for both shallow and deep changes.
    modified_: !1,
    // Used during finalization.
    finalized_: !1,
    // Track which properties have been assigned (true) or deleted (false).
    assigned_: {},
    // The parent draft state.
    parent_: t,
    // The base state.
    base_: e,
    // The base proxy.
    draft_: null,
    // set below
    // The base copy with any updated values.
    copy_: null,
    // Called by the `produce` function.
    revoke_: null,
    isManual_: !1
  };
  let n = r, o = Ot;
  i && (n = [r], o = Ee);
  const { revoke: a, proxy: c } = Proxy.revocable(n, o);
  return r.draft_ = c, r.revoke_ = a, c;
}
var Ot = {
  get(e, t) {
    if (t === j)
      return e;
    const i = q(e);
    if (!wt(i, t))
      return ho(e, i, t);
    const r = i[t];
    return e.finalized_ || !te(r) ? r : r === ht(e.base_, t) ? (gt(e), e.copy_[t] = It(r, e)) : r;
  },
  has(e, t) {
    return t in q(e);
  },
  ownKeys(e) {
    return Reflect.ownKeys(q(e));
  },
  set(e, t, i) {
    const r = or(q(e), t);
    if (r != null && r.set)
      return r.set.call(e.draft_, i), !0;
    if (!e.modified_) {
      const n = ht(q(e), t), o = n == null ? void 0 : n[j];
      if (o && o.base_ === i)
        return e.copy_[t] = i, e.assigned_[t] = !1, !0;
      if (no(i, n) && (i !== void 0 || wt(e.base_, t)))
        return !0;
      gt(e), Et(e);
    }
    return e.copy_[t] === i && // special case: handle new props with value 'undefined'
    (i !== void 0 || t in e.copy_) || // special case: NaN
    Number.isNaN(i) && Number.isNaN(e.copy_[t]) || (e.copy_[t] = i, e.assigned_[t] = !0), !0;
  },
  deleteProperty(e, t) {
    return ht(e.base_, t) !== void 0 || t in e.base_ ? (e.assigned_[t] = !1, gt(e), Et(e)) : delete e.assigned_[t], e.copy_ && delete e.copy_[t], !0;
  },
  // Note: We never coerce `desc.value` into an Immer draft, because we can't make
  // the same guarantee in ES5 mode.
  getOwnPropertyDescriptor(e, t) {
    const i = q(e), r = Reflect.getOwnPropertyDescriptor(i, t);
    return r && {
      writable: !0,
      configurable: e.type_ !== 1 || t !== "length",
      enumerable: r.enumerable,
      value: i[t]
    };
  },
  defineProperty() {
    k(11);
  },
  getPrototypeOf(e) {
    return be(e.base_);
  },
  setPrototypeOf() {
    k(12);
  }
}, Ee = {};
Me(Ot, (e, t) => {
  Ee[e] = function() {
    return arguments[0] = arguments[0][0], t.apply(this, arguments);
  };
});
Ee.deleteProperty = function(e, t) {
  return process.env.NODE_ENV !== "production" && isNaN(parseInt(t)) && k(13), Ee.set.call(this, e, t, void 0);
};
Ee.set = function(e, t, i) {
  return process.env.NODE_ENV !== "production" && t !== "length" && isNaN(parseInt(t)) && k(14), Ot.set.call(this, e[0], t, i, e[0]);
};
function ht(e, t) {
  const i = e[j];
  return (i ? q(i) : e)[t];
}
function ho(e, t, i) {
  var n;
  const r = or(t, i);
  return r ? "value" in r ? r.value : (
    // This is a very special case, if the prop is a getter defined by the
    // prototype, we should invoke it with the draft as context!
    (n = r.get) == null ? void 0 : n.call(e.draft_)
  ) : void 0;
}
function or(e, t) {
  if (!(t in e))
    return;
  let i = be(e);
  for (; i; ) {
    const r = Object.getOwnPropertyDescriptor(i, t);
    if (r)
      return r;
    i = be(i);
  }
}
function Et(e) {
  e.modified_ || (e.modified_ = !0, e.parent_ && Et(e.parent_));
}
function gt(e) {
  e.copy_ || (e.copy_ = yt(
    e.base_,
    e.scope_.immer_.useStrictShallowCopy_
  ));
}
var go = class {
  constructor(e) {
    this.autoFreeze_ = !0, this.useStrictShallowCopy_ = !1, this.useStrictIteration_ = !0, this.produce = (t, i, r) => {
      if (typeof t == "function" && typeof i != "function") {
        const o = i;
        i = t;
        const a = this;
        return function(u = o, ...l) {
          return a.produce(u, (s) => i.call(this, s, ...l));
        };
      }
      typeof i != "function" && k(6), r !== void 0 && typeof r != "function" && k(7);
      let n;
      if (te(t)) {
        const o = bi(this), a = It(t, void 0);
        let c = !0;
        try {
          n = i(a), c = !1;
        } finally {
          c ? bt(o) : zt(o);
        }
        return yi(o, r), zi(n, o);
      } else if (!t || typeof t != "object") {
        if (n = i(t), n === void 0 && (n = t), n === tr && (n = void 0), this.autoFreeze_ && Qt(n, !0), r) {
          const o = [], a = [];
          ie("Patches").generateReplacementPatches_(t, n, o, a), r(o, a);
        }
        return n;
      } else
        k(1, t);
    }, this.produceWithPatches = (t, i) => {
      if (typeof t == "function")
        return (a, ...c) => this.produceWithPatches(a, (u) => t(u, ...c));
      let r, n;
      return [this.produce(t, i, (a, c) => {
        r = a, n = c;
      }), r, n];
    }, typeof (e == null ? void 0 : e.autoFreeze) == "boolean" && this.setAutoFreeze(e.autoFreeze), typeof (e == null ? void 0 : e.useStrictShallowCopy) == "boolean" && this.setUseStrictShallowCopy(e.useStrictShallowCopy), typeof (e == null ? void 0 : e.useStrictIteration) == "boolean" && this.setUseStrictIteration(e.useStrictIteration);
  }
  createDraft(e) {
    te(e) || k(8), he(e) && (e = uo(e));
    const t = bi(this), i = It(e, void 0);
    return i[j].isManual_ = !0, zt(t), i;
  }
  finishDraft(e, t) {
    const i = e && e[j];
    (!i || !i.isManual_) && k(9);
    const { scope_: r } = i;
    return yi(r, t), zi(void 0, r);
  }
  /**
   * Pass true to automatically freeze all copies created by Immer.
   *
   * By default, auto-freezing is enabled.
   */
  setAutoFreeze(e) {
    this.autoFreeze_ = e;
  }
  /**
   * Pass true to enable strict shallow copy.
   *
   * By default, immer does not copy the object descriptors such as getter, setter and non-enumrable properties.
   */
  setUseStrictShallowCopy(e) {
    this.useStrictShallowCopy_ = e;
  }
  /**
   * Pass false to use faster iteration that skips non-enumerable properties
   * but still handles symbols for compatibility.
   *
   * By default, strict iteration is enabled (includes all own properties).
   */
  setUseStrictIteration(e) {
    this.useStrictIteration_ = e;
  }
  shouldUseStrictIteration() {
    return this.useStrictIteration_;
  }
  applyPatches(e, t) {
    let i;
    for (i = t.length - 1; i >= 0; i--) {
      const n = t[i];
      if (n.path.length === 0 && n.op === "replace") {
        e = n.value;
        break;
      }
    }
    i > -1 && (t = t.slice(i + 1));
    const r = ie("Patches").applyPatches_;
    return he(e) ? r(e, t) : this.produce(
      e,
      (n) => r(n, t)
    );
  }
};
function It(e, t) {
  const i = Ie(e) ? ie("MapSet").proxyMap_(e, t) : Ue(e) ? ie("MapSet").proxySet_(e, t) : lo(e, t);
  return (t ? t.scope_ : nr()).drafts_.push(i), i;
}
function uo(e) {
  return he(e) || k(10, e), ar(e);
}
function ar(e) {
  if (!te(e) || Xe(e))
    return e;
  const t = e[j];
  let i, r = !0;
  if (t) {
    if (!t.modified_)
      return t.base_;
    t.finalized_ = !0, i = yt(e, t.scope_.immer_.useStrictShallowCopy_), r = t.scope_.immer_.shouldUseStrictIteration();
  } else
    i = yt(e, !0);
  return Me(
    i,
    (n, o) => {
      rr(i, n, ar(o));
    },
    r
  ), t && (t.finalized_ = !1), i;
}
var fo = new go(), Ao = fo.produce;
const po = (e) => (t, i, r) => (r.setState = (n, o, ...a) => {
  const c = typeof n == "function" ? Ao(n) : n;
  return t(c, o, ...a);
}, e(r.setState, i, r)), mo = po, Co = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 580 560'%3E%3Crect width='580' height='560' fill='%23faf6f0'/%3E%3Cg opacity='.18' stroke='%238b4513' stroke-width='1'%3E%3Cpath d='M80 80H500M80 160H500M80 240H500M80 320H500M80 400H500M80 480H500'/%3E%3Cpath d='M100 55V505M210 55V505M320 55V505M430 55V505'/%3E%3C/g%3E%3Ccircle cx='460' cy='420' r='54' fill='%23a03020' opacity='.10'/%3E%3C/svg%3E", xo = "data:image/png;base64,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", wo = {
  kongshengMiaoyou: xo
}, vt = {
  id: "sample",
  title: "春江花月夜",
  description: "春江潮水连海平，海上明月共潮生。滟滟随波千万里，何处春江无月明。",
  imageUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 580 360'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop stop-color='%234a8c6f'/%3E%3Cstop offset='1' stop-color='%238ed4a8'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='580' height='360' fill='url(%23g)'/%3E%3Cpath d='M0 280 C120 180 220 240 300 150 C390 70 500 160 580 112 L580 360 L0 360Z' fill='%232c1810' opacity='.22'/%3E%3C/svg%3E",
  author: "示例作者",
  category: "水墨",
  tags: ["传统", "山水"]
};
function yo() {
  return {
    id: "title",
    type: "text",
    role: "title",
    x: 20,
    y: 244,
    width: 250,
    height: 64,
    fontSize: 22,
    color: "#2c1810",
    direction: "horizontal",
    fontWeight: "bold",
    letterSpacing: 1,
    lineHeight: 1.4,
    maxLines: 2
  };
}
function bo() {
  return {
    id: "desc",
    type: "text",
    role: "description",
    x: 20,
    y: 316,
    width: 250,
    height: 90,
    fontSize: 14,
    color: "#7a6b5d",
    direction: "horizontal",
    fontWeight: "normal",
    letterSpacing: 0,
    lineHeight: 1.8,
    maxLines: 4
  };
}
function zo() {
  return {
    id: "hero-image",
    type: "image",
    source: "dynamic",
    x: 18,
    y: 22,
    width: 254,
    height: 160,
    objectFit: "cover",
    shape: "trapezoid",
    clipPath: "polygon(0 0, 100% 0, 92% 100%, 0 86%)",
    zIndex: 1
  };
}
const Eo = "朱文篆刻印章素材，四字为「空生妙有」，传统四字印章读法为右上空、右下生、左上妙、左下有，小篆风格，红印泥质感。";
function Io() {
  return {
    id: "seal",
    type: "image",
    role: "stamp",
    source: "static",
    staticUrl: wo.kongshengMiaoyou,
    prompt: Eo,
    x: 238,
    y: 326,
    width: 30,
    height: 30,
    objectFit: "contain",
    objectPosition: "50% 50%",
    opacity: 0.9,
    shape: "rectangle",
    zIndex: 24
  };
}
function J(e, t) {
  return e.elements.find((i) => i.id === t);
}
function dt(e, t, i, r) {
  if (t.type === "image" || t.type === "text") {
    t.x = D(i, -N, N - 8), t.y = D(r, -e.height, e.height - 8);
    return;
  }
  t.x = D(i, 0, N - 8), t.y = D(r, 0, e.height - 8);
}
function M(e) {
  e.past.push(ne(e.template)), e.future = [];
}
const I = to()(
  mo((e) => ({
    template: ne(le[0]),
    selectedId: "title",
    sampleArticle: vt,
    fontConfig: Zi,
    past: [],
    future: [],
    exportedJson: "",
    loadTemplate: (t, i) => e((r) => {
      var n;
      r.template = ne(oe(t)), r.selectedId = ((n = r.template.elements.find((o) => o.type === "text")) == null ? void 0 : n.id) ?? null, r.sampleArticle = i ?? vt, r.past = [], r.future = [], r.exportedJson = "";
    }),
    createTemplate: () => e((t) => {
      var n;
      M(t);
      const i = ne(oe(le[0])), r = Date.now().toString(36);
      i.id = `custom-${r}`, i.name = `自定义模板 ${r}`, t.template = i, t.selectedId = ((n = i.elements.find((o) => o.type === "text")) == null ? void 0 : n.id) ?? null, t.past = [], t.future = [], t.exportedJson = "";
    }),
    selectElement: (t) => e({ selectedId: t }),
    toggleContentElement: (t, i) => e((r) => {
      M(r);
      const n = (a) => t === "hero" ? a.type === "image" && a.source === "dynamic" : t === "stamp" ? a.type === "image" && a.role === "stamp" : a.type === "text" && a.role === t, o = r.template.elements.some(n);
      if (!i && o && (r.template.elements = r.template.elements.filter((a) => !n(a)), r.selectedId && !J(r.template, r.selectedId) && (r.selectedId = null)), i && !o) {
        const a = t === "hero" ? zo() : t === "title" ? yo() : t === "description" ? bo() : Io();
        r.template.elements.push(a), r.selectedId = a.id;
      }
    }),
    addBackgroundImage: () => e((t) => {
      M(t);
      const i = t.template.elements.filter(
        (n) => n.type === "image" && n.source === "static" && n.role !== "stamp"
      ).length, r = {
        id: `bg-${i + 1}`,
        type: "image",
        role: "background",
        source: "static",
        staticUrl: Co,
        x: 16 + i * 8,
        y: 16 + i * 8,
        width: 258,
        height: 180,
        objectFit: "cover",
        objectPosition: "50% 50%",
        shape: "rectangle",
        zIndex: 0
      };
      t.template.elements.push(r), t.selectedId = r.id;
    }),
    addLine: () => e((t) => {
      M(t);
      const r = {
        id: `line-${t.template.elements.filter((n) => n.type === "line").length + 1}`,
        type: "line",
        x: 64,
        y: Math.floor(t.template.height / 2),
        length: 150,
        direction: "horizontal",
        thickness: 0.5,
        color: "rgba(139, 69, 19, 0.5)",
        zIndex: 10
      };
      t.template.elements.push(r), t.selectedId = r.id;
    }),
    deleteElement: (t) => e((i) => {
      M(i), i.template.elements = i.template.elements.filter((r) => r.id !== t), i.selectedId === t && (i.selectedId = null);
    }),
    recordHistory: () => e((t) => {
      M(t);
    }),
    moveElement: (t, i, r) => e((n) => {
      const o = J(n.template, t);
      o && dt(n.template, o, V(o.x + i), V(o.y + r));
    }),
    moveElementTo: (t, i, r) => e((n) => {
      const o = J(n.template, t);
      o && dt(n.template, o, i, r);
    }),
    nudgeElement: (t, i, r) => e((n) => {
      const o = J(n.template, t);
      o && dt(n.template, o, o.x + i, o.y + r);
    }),
    resizeElement: (t, i, r) => e((n) => {
      const o = J(n.template, t);
      if (o && (o.type === "text" && (o.direction === "horizontal" ? o.width = D(V(o.width + i), 40, N * 2) : o.height = D(V(o.height + r), 40, n.template.height * 2)), o.type === "image" && (o.width = D(V(o.width + i), 40, N * 2), o.height = D(V(o.height + r), 40, n.template.height * 2)), o.type === "line")) {
        const a = o.direction === "horizontal" ? i : r;
        o.length = D(V(o.length + a), 24, 280);
      }
    }),
    resizeCardHeight: (t) => e((i) => {
      i.template.height = D(i.template.height + t, 180, 720);
    }),
    updateElement: (t, i) => e((r) => {
      M(r);
      const n = J(r.template, t);
      n && Object.assign(n, i);
    }),
    updateCard: (t) => e((i) => {
      M(i), t.height !== void 0 && (i.template.height = D(t.height, 180, 720)), t.backgroundColor !== void 0 && (i.template.backgroundColor = t.backgroundColor), t.borderRadius !== void 0 && (i.template.borderRadius = t.borderRadius);
    }),
    updateFontConfig: (t) => e((i) => {
      i.fontConfig = { ...i.fontConfig, ...t };
    }),
    undo: () => e((t) => {
      const i = t.past.pop();
      i && (t.future.push(ne(t.template)), t.template = i, t.selectedId && !J(t.template, t.selectedId) && (t.selectedId = null));
    }),
    redo: () => e((t) => {
      const i = t.future.pop();
      i && (t.past.push(ne(t.template)), t.template = i, t.selectedId && !J(t.template, t.selectedId) && (t.selectedId = null));
    }),
    exportJson: () => e((t) => {
      t.exportedJson = JSON.stringify(oe(t.template), null, 2);
    }),
    importJson: (t) => e((i) => {
      var n;
      const r = JSON.parse(t);
      M(i), i.template = oe(r), i.selectedId = ((n = r.elements[0]) == null ? void 0 : n.id) ?? null, i.exportedJson = "";
    })
  }))
), vo = 6;
function kt(e, t) {
  if (e.type === "text" && e.direction === "vertical") {
    const i = e.content ?? (e.role === "title" ? t.title : e.role === "description" ? t.description ?? "" : ""), r = qi(i, e, e.lineHeight ?? 1.6);
    return {
      x: e.x + r.xOffset,
      y: e.y,
      width: r.width,
      height: e.height
    };
  }
  return e.type === "text" && e.direction === "horizontal" ? {
    x: e.x,
    y: e.y,
    width: e.width,
    height: Vi(e).height
  } : e.type === "line" ? {
    x: e.x,
    y: e.y,
    width: e.direction === "horizontal" ? e.length : e.thickness,
    height: e.direction === "horizontal" ? e.thickness : e.length
  } : {
    x: e.x,
    y: e.y,
    width: e.width,
    height: e.height
  };
}
function Lo(e, t, i) {
  const r = [0, e.width / 2, e.width], n = [0, e.height / 2, e.height];
  return e.elements.forEach((o) => {
    if (o.id === t) return;
    const a = kt(o, i);
    r.push(a.x, a.x + a.width / 2, a.x + a.width), n.push(a.y, a.y + a.height / 2, a.y + a.height);
  }), { vertical: r, horizontal: n };
}
function Ii(e, t) {
  let i = null;
  return e.forEach((r) => {
    t.forEach((n) => {
      const o = n - r, a = Math.abs(o);
      a > vo || (!i || a < i.distance) && (i = { distance: a, delta: o, guide: n });
    });
  }), i;
}
function So(e, t, i, r, n) {
  const o = e.elements.find((g) => g.id === i);
  if (!o) return null;
  const a = kt(o, t), c = { ...a, x: a.x + r, y: a.y + n }, u = Lo(e, i, t), l = Ii(
    [c.x, c.x + c.width / 2, c.x + c.width],
    u.vertical
  ), s = Ii(
    [c.y, c.y + c.height / 2, c.y + c.height],
    u.horizontal
  ), f = r + ((l == null ? void 0 : l.delta) ?? 0), h = n + ((s == null ? void 0 : s.delta) ?? 0), d = {
    vertical: l ? [l.guide] : [],
    horizontal: s ? [s.guide] : []
  };
  return {
    x: o.x + f,
    y: o.y + h,
    guides: d
  };
}
function Bo({ selectionChromeHidden: e = !1 }) {
  const t = I((g) => g.template), i = I((g) => g.selectedId), r = I((g) => g.sampleArticle), n = I((g) => g.fontConfig), o = I((g) => g.selectElement), a = I((g) => g.recordHistory), c = I((g) => g.moveElementTo), u = I((g) => g.resizeElement), l = I((g) => g.resizeCardHeight), [s, f] = G(null), h = t.elements.find((g) => g.id === i), d = h ? kt(h, r) : null;
  return /* @__PURE__ */ E("section", { className: "cm-editor-canvas", "aria-label": "模板画布", children: [
    /* @__PURE__ */ A("div", { className: "cm-editor-canvas-grid" }),
    /* @__PURE__ */ E(
      "div",
      {
        className: "cm-editor-canvas-card",
        style: { width: t.width, height: t.height },
        onClick: () => o(null),
        children: [
          /* @__PURE__ */ A(
            _i,
            {
              article: r,
              template: t,
              fontConfig: n,
              editorMode: !0,
              selectedElementId: e ? null : i,
              onSelectElement: o,
              onElementPointerDown: (g, p) => {
                f(null), ot({
                  event: p,
                  onStart: a,
                  onMove: (C, w) => {
                    const z = I.getState(), x = So(z.template, z.sampleArticle, g, C, w);
                    x && (f(x.guides.vertical.length || x.guides.horizontal.length ? x.guides : null), c(g, x.x, x.y));
                  },
                  onEnd: () => f(null)
                });
              }
            }
          ),
          s == null ? void 0 : s.vertical.map((g) => /* @__PURE__ */ A("div", { className: "cm-editor-guide cm-editor-guide-vertical", style: { left: g } }, `v-${g}`)),
          s == null ? void 0 : s.horizontal.map((g) => /* @__PURE__ */ A("div", { className: "cm-editor-guide cm-editor-guide-horizontal", style: { top: g } }, `h-${g}`)),
          !e && h && d ? /* @__PURE__ */ A(
            "button",
            {
              type: "button",
              "aria-label": "调整元素大小",
              className: "cm-editor-resize-handle",
              style: {
                left: d.x + d.width - 6,
                top: d.y + d.height - 6
              },
              onPointerDown: (g) => {
                ot({
                  event: g,
                  onStart: a,
                  onMove: (p, C) => u(h.id, p, C)
                });
              }
            }
          ) : null,
          /* @__PURE__ */ A(
            "button",
            {
              type: "button",
              "aria-label": "调整画布高度",
              className: "cm-editor-card-height-handle",
              style: {
                left: t.width / 2 - 24,
                top: t.height - 6
              },
              onPointerDown: (g) => {
                ot({
                  event: g,
                  onStart: a,
                  onMove: (p, C) => l(C)
                });
              }
            }
          )
        ]
      }
    ),
    /* @__PURE__ */ E("div", { className: "cm-editor-canvas-size", children: [
      t.width,
      " x ",
      t.height,
      "px"
    ] })
  ] });
}
function Po(e, t) {
  return t === "hero" ? e.some((i) => i.type === "image" && i.source === "dynamic") : t === "stamp" ? e.some((i) => i.type === "image" && i.role === "stamp") : e.some((i) => i.type === "text" && i.role === t);
}
function vi(e, t) {
  return e.content === "“" ? `左引号-${t + 1}` : `文字装饰-${t + 1}`;
}
function Ho() {
  const e = I((s) => s.template), t = I((s) => s.selectedId), i = I((s) => s.selectElement), r = I((s) => s.toggleContentElement), n = I((s) => s.addBackgroundImage), o = I((s) => s.addLine), a = I((s) => s.deleteElement), c = e.elements.filter(
    (s) => s.type === "image" && s.source === "static" && s.role !== "stamp"
  ), u = e.elements.filter(
    (s) => s.type === "text" && s.role === "decoration"
  ), l = e.elements.filter((s) => s.type === "line");
  return /* @__PURE__ */ E("aside", { className: "cm-editor-left", "aria-label": "元素控制面板", children: [
    /* @__PURE__ */ A("h3", { children: "内容元素" }),
    [
      ["hero", "首图", "图"],
      ["title", "标题", "T"],
      ["description", "摘要", "T"],
      ["stamp", "印章", "印"]
    ].map(([s, f, h]) => /* @__PURE__ */ E("label", { className: "cm-editor-check-row", children: [
      /* @__PURE__ */ A(
        "input",
        {
          type: "checkbox",
          "aria-label": `显示${f}`,
          checked: Po(e.elements, s),
          onChange: (d) => r(s, d.target.checked)
        }
      ),
      /* @__PURE__ */ A("span", { className: "cm-editor-icon", children: h }),
      /* @__PURE__ */ A("span", { className: "cm-editor-check-label", children: f })
    ] }, s)),
    /* @__PURE__ */ E("div", { className: "cm-editor-panel-section", children: [
      /* @__PURE__ */ A("div", { className: "cm-editor-section-title", children: "背景图片" }),
      c.map((s, f) => /* @__PURE__ */ E(
        "div",
        {
          className: `cm-editor-list-row ${t === s.id ? "active" : ""}`,
          onClick: () => i(s.id),
          children: [
            /* @__PURE__ */ E("span", { children: [
              "背景图-",
              f + 1
            ] }),
            /* @__PURE__ */ A(
              "button",
              {
                type: "button",
                "aria-label": `删除背景图-${f + 1}`,
                onClick: (h) => {
                  h.stopPropagation(), a(s.id);
                },
                children: "×"
              }
            )
          ]
        },
        s.id
      )),
      /* @__PURE__ */ A("button", { type: "button", className: "cm-editor-secondary", onClick: n, children: "添加图片" })
    ] }),
    u.length ? /* @__PURE__ */ E("div", { className: "cm-editor-panel-section", children: [
      /* @__PURE__ */ A("div", { className: "cm-editor-section-title", children: "文字装饰" }),
      u.map((s, f) => /* @__PURE__ */ E(
        "div",
        {
          className: `cm-editor-list-row ${t === s.id ? "active" : ""}`,
          onClick: () => i(s.id),
          children: [
            /* @__PURE__ */ A("span", { children: vi(s, f) }),
            /* @__PURE__ */ A(
              "button",
              {
                type: "button",
                "aria-label": `删除${vi(s, f)}`,
                onClick: (h) => {
                  h.stopPropagation(), a(s.id);
                },
                children: "×"
              }
            )
          ]
        },
        s.id
      ))
    ] }) : null,
    /* @__PURE__ */ E("div", { className: "cm-editor-panel-section", children: [
      /* @__PURE__ */ A("div", { className: "cm-editor-section-title", children: "装饰线条" }),
      l.map((s, f) => /* @__PURE__ */ E(
        "div",
        {
          className: `cm-editor-list-row ${t === s.id ? "active" : ""}`,
          onClick: () => i(s.id),
          children: [
            /* @__PURE__ */ E("span", { children: [
              s.direction === "horizontal" ? "横线" : "竖线",
              "-",
              f + 1
            ] }),
            /* @__PURE__ */ A(
              "button",
              {
                type: "button",
                "aria-label": `删除线条-${f + 1}`,
                onClick: (h) => {
                  h.stopPropagation(), a(s.id);
                },
                children: "×"
              }
            )
          ]
        },
        s.id
      )),
      /* @__PURE__ */ A("button", { type: "button", className: "cm-editor-secondary", onClick: o, children: "添加线条" })
    ] })
  ] });
}
function Ze() {
  return (Ze = Object.assign || function(e) {
    for (var t = 1; t < arguments.length; t++) {
      var i = arguments[t];
      for (var r in i) Object.prototype.hasOwnProperty.call(i, r) && (e[r] = i[r]);
    }
    return e;
  }).apply(this, arguments);
}
function cr(e, t) {
  if (e == null) return {};
  var i, r, n = {}, o = Object.keys(e);
  for (r = 0; r < o.length; r++) t.indexOf(i = o[r]) >= 0 || (n[i] = e[i]);
  return n;
}
function xe(e) {
  var t = Y(e), i = Y(function(r) {
    t.current && t.current(r);
  });
  return t.current = e, i.current;
}
var ge = function(e, t, i) {
  return t === void 0 && (t = 0), i === void 0 && (i = 1), e > i ? i : e < t ? t : e;
}, we = function(e) {
  return "touches" in e;
}, Lt = function(e) {
  return e && e.ownerDocument.defaultView || self;
}, Li = function(e, t, i) {
  var r = e.getBoundingClientRect(), n = we(t) ? function(o, a) {
    for (var c = 0; c < o.length; c++) if (o[c].identifier === a) return o[c];
    return o[0];
  }(t.touches, i) : t;
  return { left: ge((n.pageX - (r.left + Lt(e).pageXOffset)) / r.width), top: ge((n.pageY - (r.top + Lt(e).pageYOffset)) / r.height) };
}, Si = function(e) {
  !we(e) && e.preventDefault();
}, jt = B.memo(function(e) {
  var t = e.onMove, i = e.onKey, r = e.onEnd, n = cr(e, ["onMove", "onKey", "onEnd"]), o = Y(null), a = xe(t), c = xe(i), u = xe(r), l = Y(null), s = Y(!1), f = ue(function() {
    var C = function(x) {
      Si(x), (we(x) ? x.touches.length > 0 : x.buttons > 0) && o.current ? a(Li(o.current, x, l.current)) : (z(!1), u());
    }, w = function() {
      z(!1), u();
    };
    function z(x) {
      var y = s.current, L = Lt(o.current), b = x ? L.addEventListener : L.removeEventListener;
      b(y ? "touchmove" : "mousemove", C), b(y ? "touchend" : "mouseup", w);
    }
    return [function(x) {
      var y = x.nativeEvent, L = o.current;
      if (L && (Si(y), !function(m, H) {
        return H && !we(m);
      }(y, s.current) && L)) {
        if (we(y)) {
          s.current = !0;
          var b = y.changedTouches || [];
          b.length && (l.current = b[0].identifier);
        }
        L.focus(), a(Li(L, y, l.current)), z(!0);
      }
    }, function(x) {
      var y = x.which || x.keyCode;
      y < 37 || y > 40 || (x.preventDefault(), c({ left: y === 39 ? 0.05 : y === 37 ? -0.05 : 0, top: y === 40 ? 0.05 : y === 38 ? -0.05 : 0 }));
    }, function(x) {
      var y = x.which || x.keyCode;
      y >= 37 && y <= 40 && u();
    }, z];
  }, [c, a, u]), h = f[0], d = f[1], g = f[2], p = f[3];
  return W(function() {
    return p;
  }, [p]), B.createElement("div", Ze({}, n, { onTouchStart: h, onMouseDown: h, className: "react-colorful__interactive", ref: o, onKeyDown: d, onKeyUp: g, tabIndex: 0, role: "slider" }));
}), Ve = function(e) {
  return e.filter(Boolean).join(" ");
}, Rt = function(e) {
  var t = e.color, i = e.left, r = e.top, n = r === void 0 ? 0.5 : r, o = Ve(["react-colorful__pointer", e.className]);
  return B.createElement("div", { className: o, style: { top: 100 * n + "%", left: 100 * i + "%" } }, B.createElement("div", { className: "react-colorful__pointer-fill", style: { backgroundColor: t } }));
}, O = function(e, t, i) {
  return t === void 0 && (t = 0), i === void 0 && (i = Math.pow(10, t)), Math.round(i * e) / i;
}, sr = function(e) {
  var t = e.s, i = e.v, r = e.a, n = (200 - t) * i / 100;
  return { h: O(e.h), s: O(n > 0 && n < 200 ? t * i / 100 / (n <= 100 ? n : 200 - n) * 100 : 0), l: O(n / 2), a: O(r, 2) };
}, St = function(e) {
  var t = sr(e);
  return "hsl(" + t.h + ", " + t.s + "%, " + t.l + "%)";
}, ut = function(e) {
  var t = sr(e);
  return "hsla(" + t.h + ", " + t.s + "%, " + t.l + "%, " + t.a + ")";
}, Qo = function(e) {
  var t = e.h, i = e.s, r = e.v, n = e.a;
  t = t / 360 * 6, i /= 100, r /= 100;
  var o = Math.floor(t), a = r * (1 - i), c = r * (1 - (t - o) * i), u = r * (1 - (1 - t + o) * i), l = o % 6;
  return { r: O(255 * [r, c, a, a, u, r][l]), g: O(255 * [u, r, r, c, a, a][l]), b: O(255 * [a, a, u, r, r, c][l]), a: O(n, 2) };
}, Oo = function(e) {
  var t = /rgba?\(?\s*(-?\d*\.?\d+)(%)?[,\s]+(-?\d*\.?\d+)(%)?[,\s]+(-?\d*\.?\d+)(%)?,?\s*[/\s]*(-?\d*\.?\d+)?(%)?\s*\)?/i.exec(e);
  return t ? ko({ r: Number(t[1]) / (t[2] ? 100 / 255 : 1), g: Number(t[3]) / (t[4] ? 100 / 255 : 1), b: Number(t[5]) / (t[6] ? 100 / 255 : 1), a: t[7] === void 0 ? 1 : Number(t[7]) / (t[8] ? 100 : 1) }) : { h: 0, s: 0, v: 0, a: 1 };
}, ko = function(e) {
  var t = e.r, i = e.g, r = e.b, n = e.a, o = Math.max(t, i, r), a = o - Math.min(t, i, r), c = a ? o === t ? (i - r) / a : o === i ? 2 + (r - t) / a : 4 + (t - i) / a : 0;
  return { h: O(60 * (c < 0 ? c + 6 : c)), s: O(o ? a / o * 100 : 0), v: O(o / 255 * 100), a: n };
}, jo = B.memo(function(e) {
  var t = e.hue, i = e.onChange, r = e.onChangeEnd, n = Ve(["react-colorful__hue", e.className]);
  return B.createElement("div", { className: n }, B.createElement(jt, { onMove: function(o) {
    i({ h: 360 * o.left });
  }, onKey: function(o) {
    i({ h: ge(t + 360 * o.left, 0, 360) });
  }, onEnd: r, "aria-label": "Hue", "aria-valuenow": O(t), "aria-valuemax": "360", "aria-valuemin": "0" }, B.createElement(Rt, { className: "react-colorful__hue-pointer", left: t / 360, color: St({ h: t, s: 100, v: 100, a: 1 }) })));
}), Ro = B.memo(function(e) {
  var t = e.hsva, i = e.onChange, r = e.onChangeEnd, n = { backgroundColor: St({ h: t.h, s: 100, v: 100, a: 1 }) };
  return B.createElement("div", { className: "react-colorful__saturation", style: n }, B.createElement(jt, { onMove: function(o) {
    i({ s: 100 * o.left, v: 100 - 100 * o.top });
  }, onKey: function(o) {
    i({ s: ge(t.s + 100 * o.left, 0, 100), v: ge(t.v - 100 * o.top, 0, 100) });
  }, onEnd: r, "aria-label": "Color", "aria-valuetext": "Saturation " + O(t.s) + "%, Brightness " + O(t.v) + "%" }, B.createElement(Rt, { className: "react-colorful__saturation-pointer", top: 1 - t.v / 100, left: t.s / 100, color: St(t) })));
}), Do = function(e, t) {
  if (e === t) return !0;
  for (var i in e) if (e[i] !== t[i]) return !1;
  return !0;
}, To = function(e, t) {
  return e.replace(/\s/g, "") === t.replace(/\s/g, "");
};
function Yo(e, t, i, r) {
  var n = xe(i), o = xe(r), a = G(function() {
    return e.toHsva(t);
  }), c = a[0], u = a[1], l = Y({ color: t, hsva: c }), s = Y(!1);
  W(function() {
    if (!e.equal(t, l.current.color)) {
      var d = e.toHsva(t);
      l.current = { hsva: d, color: t }, u(d), s.current = !1;
    }
  }, [t, e]), W(function() {
    var d;
    Do(c, l.current.hsva) || e.equal(d = e.fromHsva(c), l.current.color) || (l.current = { hsva: c, color: d }, n(d), s.current = !0);
  }, [c, e, n]);
  var f = Wt(function(d) {
    u(function(g) {
      return Object.assign({}, g, d);
    });
  }, []), h = Wt(function() {
    s.current && (s.current = !1, o(l.current.color));
  }, [o]);
  return [c, f, h];
}
var Fo = typeof window < "u" ? pr : W, Mo = function() {
  return typeof __webpack_nonce__ < "u" ? __webpack_nonce__ : void 0;
}, Bi = /* @__PURE__ */ new Map(), Wo = function(e) {
  Fo(function() {
    var t = e.current ? e.current.ownerDocument : document;
    if (t !== void 0 && !Bi.has(t)) {
      var i = t.createElement("style");
      i.innerHTML = `.react-colorful{position:relative;display:flex;flex-direction:column;width:200px;height:200px;-webkit-user-select:none;-moz-user-select:none;-ms-user-select:none;user-select:none;cursor:default}.react-colorful__saturation{position:relative;flex-grow:1;border-color:transparent;border-bottom:12px solid #000;border-radius:8px 8px 0 0;background-image:linear-gradient(0deg,#000,transparent),linear-gradient(90deg,#fff,hsla(0,0%,100%,0))}.react-colorful__alpha-gradient,.react-colorful__pointer-fill{content:"";position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;border-radius:inherit}.react-colorful__alpha-gradient,.react-colorful__saturation{box-shadow:inset 0 0 0 1px rgba(0,0,0,.05)}.react-colorful__alpha,.react-colorful__hue{position:relative;height:24px}.react-colorful__hue{background:linear-gradient(90deg,red 0,#ff0 17%,#0f0 33%,#0ff 50%,#00f 67%,#f0f 83%,red)}.react-colorful__last-control{border-radius:0 0 8px 8px}.react-colorful__interactive{position:absolute;left:0;top:0;right:0;bottom:0;border-radius:inherit;outline:none;touch-action:none}.react-colorful__pointer{position:absolute;z-index:1;box-sizing:border-box;width:28px;height:28px;transform:translate(-50%,-50%);background-color:#fff;border:2px solid #fff;border-radius:50%;box-shadow:0 2px 4px rgba(0,0,0,.2)}.react-colorful__interactive:focus .react-colorful__pointer{transform:translate(-50%,-50%) scale(1.1)}.react-colorful__alpha,.react-colorful__alpha-pointer{background-color:#fff;background-image:url('data:image/svg+xml;charset=utf-8,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill-opacity=".05"><path d="M8 0h8v8H8zM0 8h8v8H0z"/></svg>')}.react-colorful__saturation-pointer{z-index:3}.react-colorful__hue-pointer{z-index:2}`, Bi.set(t, i);
      var r = Mo();
      r && i.setAttribute("nonce", r), t.head.appendChild(i);
    }
  }, []);
}, No = function(e) {
  var t = e.className, i = e.hsva, r = e.onChange, n = e.onChangeEnd, o = { backgroundImage: "linear-gradient(90deg, " + ut(Object.assign({}, i, { a: 0 })) + ", " + ut(Object.assign({}, i, { a: 1 })) + ")" }, a = Ve(["react-colorful__alpha", t]), c = O(100 * i.a);
  return B.createElement("div", { className: a }, B.createElement("div", { className: "react-colorful__alpha-gradient", style: o }), B.createElement(jt, { onMove: function(u) {
    r({ a: u.left });
  }, onKey: function(u) {
    r({ a: ge(i.a + u.left) });
  }, onEnd: n, "aria-label": "Alpha", "aria-valuetext": c + "%", "aria-valuenow": c, "aria-valuemin": "0", "aria-valuemax": "100" }, B.createElement(Rt, { className: "react-colorful__alpha-pointer", left: i.a, color: ut(i) })));
}, Ko = function(e) {
  var t = e.className, i = e.colorModel, r = e.color, n = r === void 0 ? i.defaultColor : r, o = e.onChange, a = e.onChangeEnd, c = cr(e, ["className", "colorModel", "color", "onChange", "onChangeEnd"]), u = Y(null);
  Wo(u);
  var l = Yo(i, n, o, a), s = l[0], f = l[1], h = l[2], d = Ve(["react-colorful", t]);
  return B.createElement("div", Ze({}, c, { ref: u, className: d }), B.createElement(Ro, { hsva: s, onChange: f, onChangeEnd: h }), B.createElement(jo, { hue: s.h, onChange: f, onChangeEnd: h }), B.createElement(No, { hsva: s, onChange: f, onChangeEnd: h, className: "react-colorful__last-control" }));
}, Jo = { defaultColor: "rgba(0, 0, 0, 1)", toHsva: Oo, fromHsva: function(e) {
  var t = Qo(e);
  return "rgba(" + t.r + ", " + t.g + ", " + t.b + ", " + t.a + ")";
}, equal: To }, Go = function(e) {
  return B.createElement(Ko, Ze({}, e, { colorModel: Jo }));
};
function ae({
  label: e,
  value: t,
  min: i,
  max: r,
  step: n = 1,
  onChange: o
}) {
  return /* @__PURE__ */ E("label", { className: "cm-editor-field", children: [
    /* @__PURE__ */ A("span", { children: e }),
    /* @__PURE__ */ A(
      "input",
      {
        "aria-label": e,
        type: "number",
        value: t,
        min: i,
        max: r,
        step: n,
        onChange: (a) => {
          const c = Number(a.target.value);
          Number.isFinite(c) && o(c);
        }
      }
    )
  ] });
}
function _({
  label: e,
  value: t,
  min: i,
  max: r,
  step: n = 1,
  onChange: o
}) {
  const a = (c) => {
    const u = Number(c);
    Number.isFinite(u) && o(Math.min(r, Math.max(i, u)));
  };
  return /* @__PURE__ */ E("label", { className: "cm-editor-field cm-editor-range-field", children: [
    /* @__PURE__ */ A("span", { children: e }),
    /* @__PURE__ */ E("div", { className: "cm-editor-range-row", children: [
      /* @__PURE__ */ A(
        "input",
        {
          "aria-label": e,
          type: "number",
          value: t,
          min: i,
          max: r,
          step: n,
          onChange: (c) => a(c.target.value)
        }
      ),
      /* @__PURE__ */ A(
        "input",
        {
          "aria-label": `${e}滑条`,
          type: "range",
          value: t,
          min: i,
          max: r,
          step: n,
          onChange: (c) => a(c.target.value)
        }
      )
    ] })
  ] });
}
function U({
  label: e,
  value: t,
  options: i,
  onChange: r
}) {
  return /* @__PURE__ */ E("div", { className: "cm-editor-field", children: [
    /* @__PURE__ */ A("span", { children: e }),
    /* @__PURE__ */ A("div", { className: "cm-editor-segmented", role: "group", "aria-label": e, children: i.map((n) => /* @__PURE__ */ A(
      "button",
      {
        type: "button",
        "aria-pressed": t === n.value,
        onClick: () => r(n.value),
        children: n.label
      },
      n.value
    )) })
  ] });
}
function Uo(e) {
  const t = e.trim();
  if (/^#[0-9a-f]{6}$/i.test(t)) return t;
  if (/^#[0-9a-f]{3}$/i.test(t))
    return `#${t[1]}${t[1]}${t[2]}${t[2]}${t[3]}${t[3]}`;
  const i = t.match(/^rgba?\(([^)]+)\)$/i);
  if (!i) return "#2c1810";
  const r = i[1].split(",").map((n) => Number(n.trim()));
  return r.length < 3 || r.some((n, o) => o < 3 && !Number.isFinite(n)) ? "#2c1810" : `#${r.slice(0, 3).map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0")).join("")}`;
}
function lr({
  label: e,
  value: t,
  onChange: i
}) {
  return /* @__PURE__ */ E("label", { className: "cm-editor-field cm-editor-color-field", children: [
    /* @__PURE__ */ A("span", { children: e }),
    /* @__PURE__ */ E("div", { className: "cm-editor-color-row", children: [
      /* @__PURE__ */ A("span", { className: "cm-editor-color-swatch", "aria-hidden": "true", style: { background: t } }),
      /* @__PURE__ */ A("input", { "aria-label": e, value: t, onChange: (r) => i(r.target.value) }),
      /* @__PURE__ */ A(
        "input",
        {
          "aria-label": `${e}色板`,
          type: "color",
          value: Uo(t),
          onChange: (r) => i(r.target.value)
        }
      )
    ] }),
    /* @__PURE__ */ A(Go, { color: t, onChange: i })
  ] });
}
function hr({ element: e }) {
  const t = I((o) => o.updateElement), i = e.type === "image", r = i || e.direction === "horizontal", n = i || e.direction === "vertical";
  return /* @__PURE__ */ E("div", { className: "cm-editor-geometry", children: [
    /* @__PURE__ */ A(ae, { label: "X", value: e.x, onChange: (o) => t(e.id, { x: o }) }),
    /* @__PURE__ */ A(ae, { label: "Y", value: e.y, onChange: (o) => t(e.id, { y: o }) }),
    r ? /* @__PURE__ */ A(
      ae,
      {
        label: "宽度",
        value: e.width,
        min: 1,
        onChange: (o) => t(e.id, { width: o })
      }
    ) : null,
    n ? /* @__PURE__ */ A(
      ae,
      {
        label: "高度",
        value: e.height,
        min: 1,
        onChange: (o) => t(e.id, { height: o })
      }
    ) : null
  ] });
}
function Xo({ element: e }) {
  const t = I((i) => i.updateElement);
  return /* @__PURE__ */ E(Bt, { children: [
    /* @__PURE__ */ A(hr, { element: e }),
    /* @__PURE__ */ A(
      U,
      {
        label: "排版方向",
        value: e.direction,
        options: [
          { label: "横排", value: "horizontal" },
          { label: "竖排", value: "vertical" }
        ],
        onChange: (i) => t(e.id, { direction: i })
      }
    ),
    /* @__PURE__ */ A(
      U,
      {
        label: e.direction === "vertical" ? "横向对齐" : "纵向对齐",
        value: e.blockAlign ?? "start",
        options: e.direction === "vertical" ? [
          { label: "右对齐", value: "start" },
          { label: "左对齐", value: "end" }
        ] : [
          { label: "上对齐", value: "start" },
          { label: "下对齐", value: "end" }
        ],
        onChange: (i) => t(e.id, { blockAlign: i })
      }
    ),
    e.direction === "horizontal" ? /* @__PURE__ */ A(
      U,
      {
        label: "文字对齐",
        value: e.textAlign ?? "left",
        options: [
          { label: "左对齐", value: "left" },
          { label: "居中", value: "center" },
          { label: "右对齐", value: "right" }
        ],
        onChange: (i) => t(e.id, { textAlign: i })
      }
    ) : null,
    /* @__PURE__ */ A(
      _,
      {
        label: "字号",
        value: e.fontSize,
        min: 8,
        max: 72,
        onChange: (i) => t(e.id, { fontSize: i })
      }
    ),
    /* @__PURE__ */ A(lr, { label: "颜色", value: e.color, onChange: (i) => t(e.id, { color: i }) }),
    /* @__PURE__ */ A(
      _,
      {
        label: "字间距",
        value: e.letterSpacing ?? 0,
        min: -2,
        max: 20,
        onChange: (i) => t(e.id, { letterSpacing: i })
      }
    ),
    /* @__PURE__ */ A(
      _,
      {
        label: "行间距",
        value: e.lineHeight ?? 1.6,
        min: 1,
        max: 3,
        step: 0.05,
        onChange: (i) => t(e.id, { lineHeight: i })
      }
    ),
    /* @__PURE__ */ A(
      _,
      {
        label: e.direction === "vertical" ? "最大列数" : "最大行数",
        value: e.maxLines,
        min: 1,
        max: 8,
        onChange: (i) => t(e.id, { maxLines: i })
      }
    ),
    /* @__PURE__ */ A(
      U,
      {
        label: "字重",
        value: e.fontWeight ?? "normal",
        options: [
          { label: "normal", value: "normal" },
          { label: "bold", value: "bold" }
        ],
        onChange: (i) => t(e.id, { fontWeight: i })
      }
    )
  ] });
}
function Zo({ element: e }) {
  const t = I((r) => r.updateElement), i = (r) => {
    t(e.id, { source: "static", staticUrl: r });
  };
  return /* @__PURE__ */ E(Bt, { children: [
    /* @__PURE__ */ A(hr, { element: e }),
    /* @__PURE__ */ A(
      U,
      {
        label: "图片来源",
        value: e.source,
        options: [
          { label: "文章首图", value: "dynamic" },
          { label: "固定图片", value: "static" }
        ],
        onChange: (r) => t(e.id, { source: r })
      }
    ),
    /* @__PURE__ */ E("label", { className: "cm-editor-field", children: [
      /* @__PURE__ */ A("span", { children: "图片 URL" }),
      /* @__PURE__ */ A(
        "input",
        {
          "aria-label": "图片 URL",
          value: e.staticUrl ?? "",
          placeholder: e.source === "dynamic" ? "切到固定图片后可填写" : "粘贴图片地址或 data URL",
          onChange: (r) => i(r.target.value)
        }
      )
    ] }),
    /* @__PURE__ */ E("label", { className: "cm-editor-field", children: [
      /* @__PURE__ */ A("span", { children: "生成提示词" }),
      /* @__PURE__ */ A(
        "textarea",
        {
          "aria-label": "生成提示词",
          value: e.prompt ?? "",
          placeholder: "记录这张图片的生成提示词",
          rows: 5,
          onChange: (r) => t(e.id, { prompt: r.target.value })
        }
      )
    ] }),
    /* @__PURE__ */ E("label", { className: "cm-editor-field", children: [
      /* @__PURE__ */ A("span", { children: "图片位置" }),
      /* @__PURE__ */ A(
        "input",
        {
          "aria-label": "图片位置",
          value: e.objectPosition ?? "50% 50%",
          onChange: (r) => t(e.id, { objectPosition: r.target.value })
        }
      )
    ] }),
    /* @__PURE__ */ A(
      _,
      {
        label: "透明度",
        value: e.opacity ?? 1,
        min: 0,
        max: 1,
        step: 0.05,
        onChange: (r) => t(e.id, { opacity: r })
      }
    ),
    /* @__PURE__ */ E("label", { className: "cm-editor-field", children: [
      /* @__PURE__ */ A("span", { children: "上传图片" }),
      /* @__PURE__ */ A(
        "input",
        {
          "aria-label": "上传图片",
          type: "file",
          accept: "image/*",
          onChange: (r) => {
            var a;
            const n = (a = r.target.files) == null ? void 0 : a[0];
            if (!n) return;
            const o = new FileReader();
            o.onload = () => i(String(o.result ?? "")), o.readAsDataURL(n);
          }
        }
      )
    ] }),
    /* @__PURE__ */ A(
      U,
      {
        label: "形状",
        value: e.shape,
        options: [
          { label: "矩形", value: "rectangle" },
          { label: "梯形", value: "trapezoid" }
        ],
        onChange: (r) => t(e.id, { shape: r })
      }
    ),
    /* @__PURE__ */ A(
      U,
      {
        label: "裁剪方式",
        value: e.objectFit ?? "cover",
        options: [
          { label: "cover", value: "cover" },
          { label: "contain", value: "contain" }
        ],
        onChange: (r) => t(e.id, { objectFit: r })
      }
    ),
    e.shape === "trapezoid" ? /* @__PURE__ */ E("label", { className: "cm-editor-field", children: [
      /* @__PURE__ */ A("span", { children: "clip-path" }),
      /* @__PURE__ */ A(
        "input",
        {
          "aria-label": "clip-path",
          value: e.clipPath ?? "",
          onChange: (r) => t(e.id, { clipPath: r.target.value })
        }
      )
    ] }) : null
  ] });
}
function Vo({ element: e }) {
  const t = I((i) => i.updateElement);
  return /* @__PURE__ */ E(Bt, { children: [
    /* @__PURE__ */ A(ae, { label: "X", value: e.x, onChange: (i) => t(e.id, { x: i }) }),
    /* @__PURE__ */ A(ae, { label: "Y", value: e.y, onChange: (i) => t(e.id, { y: i }) }),
    /* @__PURE__ */ A(
      U,
      {
        label: "方向",
        value: e.direction,
        options: [
          { label: "横线", value: "horizontal" },
          { label: "竖线", value: "vertical" }
        ],
        onChange: (i) => t(e.id, { direction: i })
      }
    ),
    /* @__PURE__ */ A(
      _,
      {
        label: "长度",
        value: e.length,
        min: 24,
        max: 360,
        onChange: (i) => t(e.id, { length: i })
      }
    ),
    /* @__PURE__ */ A(
      _,
      {
        label: "粗细",
        value: e.thickness,
        min: 0.5,
        max: 8,
        step: 0.5,
        onChange: (i) => t(e.id, { thickness: i })
      }
    ),
    /* @__PURE__ */ A(
      lr,
      {
        label: "线条颜色",
        value: e.color,
        onChange: (i) => t(e.id, { color: i })
      }
    )
  ] });
}
function qo(e) {
  return e.direction === "vertical" ? `竖排 · 最多 ${e.maxCharacters} 字 · ${e.charactersPerColumn} 字/列 × ${e.columnCount} 列` : `横排 · 最多 ${e.maxCharacters} 字 · ${e.charactersPerLine} 字/行 × ${e.lineCount} 行`;
}
function Pi({ label: e, capacity: t }) {
  return /* @__PURE__ */ E("div", { className: "cm-editor-capacity-row", children: [
    /* @__PURE__ */ A("span", { className: "cm-editor-capacity-label", children: e }),
    /* @__PURE__ */ A("span", { className: "cm-editor-capacity-value", children: t ? qo(t) : "未启用" })
  ] });
}
function _o({ capacity: e }) {
  return /* @__PURE__ */ E("section", { className: "cm-editor-capacity", "aria-label": "容量参数", children: [
    /* @__PURE__ */ A("div", { className: "cm-editor-section-title", children: "容量参数" }),
    /* @__PURE__ */ A(Pi, { label: "标题", capacity: e.title }),
    /* @__PURE__ */ A(Pi, { label: "摘要", capacity: e.description })
  ] });
}
function $o() {
  const e = I((n) => n.template), t = I((n) => n.selectedId), i = e.elements.find((n) => n.id === t), r = Ht(e);
  return /* @__PURE__ */ E("aside", { className: "cm-editor-right", "aria-label": "属性面板", children: [
    /* @__PURE__ */ A("h3", { children: "属性面板" }),
    /* @__PURE__ */ A(_o, { capacity: r }),
    i ? null : /* @__PURE__ */ A("p", { className: "cm-editor-muted", children: "请选择画布元素。" }),
    i ? /* @__PURE__ */ A("div", { className: "cm-editor-selected-name", children: i.id }) : null,
    (i == null ? void 0 : i.type) === "text" ? /* @__PURE__ */ A(Xo, { element: i }) : null,
    (i == null ? void 0 : i.type) === "image" ? /* @__PURE__ */ A(Zo, { element: i }) : null,
    (i == null ? void 0 : i.type) === "line" ? /* @__PURE__ */ A(Vo, { element: i }) : null
  ] });
}
function ea() {
  const e = I((n) => n.undo), t = I((n) => n.redo), i = I((n) => n.past.length > 0), r = I((n) => n.future.length > 0);
  return { undo: e, redo: t, canUndo: i, canRedo: r };
}
const Hi = [
  { label: "Georgia", value: "Georgia" },
  { label: "Times New Roman", value: '"Times New Roman"' },
  { label: "Inter", value: "Inter" },
  { label: "System UI", value: "system-ui" }
], Qi = [
  { label: "Noto Serif SC", value: '"Noto Serif SC"' },
  { label: "Noto Sans SC", value: '"Noto Sans SC"' },
  { label: "LXGW WenKai", value: '"LXGW WenKai"' },
  { label: "STKaiti / KaiTi", value: "STKaiti, KaiTi" },
  { label: "STSong / SimSun", value: "STSong, SimSun" },
  { label: "Microsoft YaHei", value: '"Microsoft YaHei"' }
];
function Oi(e, t, i) {
  return `${e}, ${t}, ${i}`;
}
function De(e, t) {
  const i = { ...e, ...t };
  return {
    ...t,
    titleFont: Oi(i.titleEnglishFont ?? "Georgia", i.titleChineseFont ?? '"Noto Serif SC"', "serif"),
    descriptionFont: Oi(
      i.descriptionEnglishFont ?? "Inter",
      i.descriptionChineseFont ?? '"Noto Sans SC"',
      "sans-serif"
    )
  };
}
function ta({ onSave: e }) {
  const [t, i] = G(!1), [r, n] = G(!1), o = I((m) => m.template), a = I((m) => m.fontConfig), c = I((m) => m.exportedJson), u = I((m) => m.createTemplate), l = I((m) => m.updateCard), s = I((m) => m.updateFontConfig), f = I((m) => m.exportJson), h = I((m) => m.importJson), { undo: d, redo: g, canUndo: p, canRedo: C } = ea(), [w, z] = G(String(o.height)), [x, y] = G(o.borderRadius ?? "6px");
  W(() => {
    z(String(o.height)), y(o.borderRadius ?? "6px");
  }, [o.height, o.borderRadius]);
  const L = ue(() => c || JSON.stringify(o, null, 2), [c, o]), b = (m) => {
    if (!m.trim()) {
      z(String(o.height));
      return;
    }
    const H = Number(m);
    Number.isFinite(H) && l({ height: H });
  };
  return /* @__PURE__ */ E("header", { className: "cm-editor-toolbar", children: [
    /* @__PURE__ */ A("button", { type: "button", onClick: u, children: "新建模板" }),
    /* @__PURE__ */ A(
      "button",
      {
        type: "button",
        onClick: () => {
          b(w), e == null || e(oe(I.getState().template));
        },
        children: "保存模板"
      }
    ),
    /* @__PURE__ */ A("button", { type: "button", onClick: d, disabled: !p, children: "撤销" }),
    /* @__PURE__ */ A("button", { type: "button", onClick: g, disabled: !C, children: "重做" }),
    /* @__PURE__ */ A("button", { type: "button", onClick: () => i((m) => !m), "aria-expanded": t, children: "全局字体" }),
    /* @__PURE__ */ E("label", { className: "cm-editor-toolbar-field", children: [
      /* @__PURE__ */ A("span", { children: "卡片高度" }),
      /* @__PURE__ */ A(
        "input",
        {
          "aria-label": "卡片高度",
          type: "number",
          min: 180,
          max: 720,
          value: w,
          onChange: (m) => {
            const H = m.target.value;
            z(H);
          },
          onBlur: () => b(w),
          onKeyDown: (m) => {
            m.key === "Enter" && b(w);
          }
        }
      )
    ] }),
    /* @__PURE__ */ E("label", { className: "cm-editor-toolbar-field", children: [
      /* @__PURE__ */ A("span", { children: "圆角" }),
      /* @__PURE__ */ A(
        "input",
        {
          "aria-label": "圆角",
          value: x,
          onChange: (m) => {
            y(m.target.value), l({ borderRadius: m.target.value });
          }
        }
      )
    ] }),
    /* @__PURE__ */ E("label", { className: "cm-editor-toolbar-field", children: [
      /* @__PURE__ */ A("span", { children: "背景色" }),
      /* @__PURE__ */ A(
        "input",
        {
          "aria-label": "背景色",
          type: "color",
          value: o.backgroundColor ?? "#f5f0e8",
          onChange: (m) => l({ backgroundColor: m.target.value })
        }
      )
    ] }),
    /* @__PURE__ */ A(
      "button",
      {
        type: "button",
        onClick: () => {
          f(), n((m) => !m);
        },
        "aria-expanded": r,
        children: "JSON"
      }
    ),
    t ? /* @__PURE__ */ E("div", { className: "cm-editor-popover", role: "dialog", "aria-label": "全局字体设置", children: [
      /* @__PURE__ */ E("label", { children: [
        /* @__PURE__ */ A("span", { children: "标题英文字体" }),
        /* @__PURE__ */ A(
          "select",
          {
            value: a.titleEnglishFont ?? "Georgia",
            onChange: (m) => s(De(a, { titleEnglishFont: m.target.value })),
            children: Hi.map((m) => /* @__PURE__ */ A("option", { value: m.value, children: m.label }, m.value))
          }
        )
      ] }),
      /* @__PURE__ */ E("label", { children: [
        /* @__PURE__ */ A("span", { children: "标题中文字体" }),
        /* @__PURE__ */ A(
          "select",
          {
            value: a.titleChineseFont ?? '"Noto Serif SC"',
            onChange: (m) => s(De(a, { titleChineseFont: m.target.value })),
            children: Qi.map((m) => /* @__PURE__ */ A("option", { value: m.value, children: m.label }, m.value))
          }
        )
      ] }),
      /* @__PURE__ */ E("label", { children: [
        /* @__PURE__ */ A("span", { children: "描述英文字体" }),
        /* @__PURE__ */ A(
          "select",
          {
            value: a.descriptionEnglishFont ?? "Inter",
            onChange: (m) => s(De(a, { descriptionEnglishFont: m.target.value })),
            children: Hi.map((m) => /* @__PURE__ */ A("option", { value: m.value, children: m.label }, m.value))
          }
        )
      ] }),
      /* @__PURE__ */ E("label", { children: [
        /* @__PURE__ */ A("span", { children: "描述中文字体" }),
        /* @__PURE__ */ A(
          "select",
          {
            value: a.descriptionChineseFont ?? '"Noto Sans SC"',
            onChange: (m) => s(De(a, { descriptionChineseFont: m.target.value })),
            children: Qi.map((m) => /* @__PURE__ */ A("option", { value: m.value, children: m.label }, m.value))
          }
        )
      ] })
    ] }) : null,
    r ? /* @__PURE__ */ E(
      "form",
      {
        className: "cm-editor-import",
        onSubmit: (m) => {
          m.preventDefault();
          const H = new FormData(m.currentTarget);
          h(String(H.get("json") ?? ""));
        },
        children: [
          /* @__PURE__ */ A("textarea", { name: "json", "aria-label": "模板 JSON", defaultValue: L }),
          /* @__PURE__ */ E("div", { className: "cm-editor-json-actions", children: [
            /* @__PURE__ */ A("button", { type: "button", onClick: f, children: "刷新导出" }),
            /* @__PURE__ */ A("button", { type: "submit", children: "应用导入" })
          ] })
        ]
      }
    ) : null
  ] });
}
function la({
  initialTemplate: e,
  sampleArticle: t = vt,
  onSave: i,
  onChange: r,
  className: n,
  style: o
}) {
  const a = I((f) => f.loadTemplate), c = I((f) => f.template), [u, l] = G(!1), s = Y(null);
  return W(() => {
    a(e, t);
  }, [e, a, t]), W(() => {
    r == null || r(oe(c));
  }, [r, c]), W(() => {
    const f = () => {
      l(!0), s.current !== null && window.clearTimeout(s.current), s.current = window.setTimeout(() => {
        l(!1), s.current = null;
      }, 700);
    }, h = (g) => g instanceof HTMLElement ? !!g.closest('input, textarea, select, [contenteditable="true"]') : !1, d = (g) => {
      if ((g.ctrlKey || g.metaKey) && g.key.toLowerCase() === "z" && (g.preventDefault(), g.shiftKey ? I.getState().redo() : I.getState().undo()), (g.ctrlKey || g.metaKey) && g.key.toLowerCase() === "y" && (g.preventDefault(), I.getState().redo()), g.ctrlKey || g.metaKey || g.altKey || h(g.target)) return;
      const C = {
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0]
      }[g.key];
      if (!C) return;
      const { selectedId: w, recordHistory: z, nudgeElement: x } = I.getState();
      if (!w) return;
      g.preventDefault();
      const y = g.shiftKey ? 10 : 1;
      z(), x(w, C[0] * y, C[1] * y), f();
    };
    return window.addEventListener("keydown", d), () => {
      window.removeEventListener("keydown", d), s.current !== null && window.clearTimeout(s.current);
    };
  }, []), /* @__PURE__ */ E("div", { className: `cm-template-editor ${n ?? ""}`, style: o, children: [
    /* @__PURE__ */ A(ta, { onSave: i }),
    /* @__PURE__ */ E("div", { className: "cm-editor-body", children: [
      /* @__PURE__ */ A(Ho, {}),
      /* @__PURE__ */ A(Bo, { selectionChromeHidden: u }),
      /* @__PURE__ */ A($o, {})
    ] }),
    /* @__PURE__ */ E("footer", { className: "cm-editor-status", children: [
      /* @__PURE__ */ E("span", { children: [
        "模板: ",
        c.id
      ] }),
      /* @__PURE__ */ E("span", { children: [
        c.width,
        " x ",
        c.height,
        "px"
      ] })
    ] })
  ] });
}
export {
  N as CARD_WIDTH,
  _i as CardRenderer,
  sa as ChineseMasonry,
  la as TemplateEditor,
  Tn as TemplateRegistry,
  Ht as calculateTemplateTextCapacity,
  hi as calculateTextCapacity,
  Yn as createDefaultRegistry,
  Mn as createTemplateSelector,
  le as defaultTemplates,
  oa as inkWashTemplate,
  aa as minimalTemplate,
  ca as verticalTextTemplate,
  oe as withTemplateTextCapacity
};
