// MPP (Machine Payments Protocol) selling surface, alongside x402.
//
// Design: one endpoint, one 402, both protocols.
//   - A request with `Authorization: Payment ...` (MPP credential) is verified
//     and settled by mppx and served directly.
//   - A request with `PAYMENT-SIGNATURE` (x402 credential) falls through to the
//     x402 middleware, untouched.
//   - An unpaid request falls through to x402's 402, onto which we graft MPP's
//     `WWW-Authenticate: Payment` challenge - so a single 402 response carries
//     both standards and either kind of agent can proceed.
//
// The two protocols use disjoint headers, which is what makes this clean:
//   MPP:  WWW-Authenticate: Payment / Authorization: Payment / Payment-Receipt
//   x402: PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE
import { Mppx, tempo } from 'mppx/express';
import { privateKeyToAccount } from 'viem/accounts';
import {
  WATCHLIST, pricePath, TREASURY_ADDRESS, FACILITATOR_PRIVATE_KEY,
  MPP_TESTNET, MPP_CURRENCY, ORACLE_PRICE_ATOMIC,
} from '../config.js';

const PRICE_USD = (Number(ORACLE_PRICE_ATOMIC) / 1e6).toString(); // '0.05'

export function createMpp() {
  // The facilitator key doubles as the Tempo fee-payer (pull mode): it
  // co-signs charge transactions and sponsors gas. Fund it on Tempo.
  // MPP_FEE_PAYER_KEY overrides it (useful for faucet-funded testnet keys).
  const account = privateKeyToAccount(process.env.MPP_FEE_PAYER_KEY || FACILITATOR_PRIVATE_KEY);
  const mpp = Mppx.create({
    methods: [tempo({
      testnet: MPP_TESTNET,
      currency: MPP_CURRENCY,
      recipient: TREASURY_ADDRESS,
      account,
      feePayer: true,
    })],
  });
  return mpp;
}

const isMppCredential = (req) => (req.headers.authorization || '').startsWith('Payment');

/**
 * Runs an mppx charge handler against a throwaway response to capture the
 * WWW-Authenticate challenge it would emit for this request, without sending
 * anything to the real client.
 */
function captureChallenge(chargeHandler, req) {
  return new Promise((resolve) => {
    const headers = {};
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(headers['www-authenticate'] || null); } };
    const mock = {
      req,
      headersSent: false,
      statusCode: 200,
      setHeader: (k, v) => { headers[String(k).toLowerCase()] = v; return mock; },
      getHeader: (k) => headers[String(k).toLowerCase()],
      removeHeader: (k) => { delete headers[String(k).toLowerCase()]; },
      set: (k, v) => { headers[String(k).toLowerCase()] = v; return mock; },
      get: (k) => headers[String(k).toLowerCase()],
      status: (c) => { mock.statusCode = c; return mock; },
      writeHead: (c) => { mock.statusCode = c; return mock; },
      json: () => { done(); return mock; },
      send: () => { done(); return mock; },
      end: () => { done(); return mock; },
      write: () => true,
      on: () => mock,
      once: () => mock,
      emit: () => false,
    };
    try {
      const out = chargeHandler(req, mock, () => done());
      if (out && typeof out.then === 'function') out.then(done, done);
      // safety valve: never hang a request on challenge capture
      setTimeout(done, 4000);
    } catch { done(); }
  });
}

/**
 * Attaches the MPP surface for every watchlist price route. Call BEFORE the
 * x402 middleware is attached so MPP credentials are consumed here and
 * everything else falls through.
 */
export function attachMpp(app, mpp, priceHandlerFor) {
  const charge = mpp.charge({ amount: PRICE_USD });

  for (const s of WATCHLIST) {
    app.get(pricePath(s.ticker), (req, res, next) => {
      if (isMppCredential(req)) return charge(req, res, next); // verify+settle, then fall into handler below
      return next('route'); // not MPP: let the x402 stack (registered later) handle it
    }, priceHandlerFor(s));
  }

  // Unpaid requests: graft the MPP challenge onto whatever 402 x402 emits,
  // so one response advertises both protocols. Stripped again if the
  // response turns out not to be a 402.
  app.use(async (req, res, next) => {
    const isPriceGet = req.method === 'GET' && WATCHLIST.some((s) => req.path === pricePath(s.ticker));
    if (!isPriceGet || isMppCredential(req) || req.headers['payment-signature']) return next();
    try {
      const challenge = await captureChallenge(charge, req);
      if (challenge) {
        res.set('WWW-Authenticate', challenge);
        const writeHead = res.writeHead.bind(res);
        res.writeHead = (...args) => {
          if ((args[0] ?? res.statusCode) !== 402) res.removeHeader('WWW-Authenticate');
          return writeHead(...args);
        };
      }
    } catch { /* challenge grafting is best-effort; x402 flow proceeds regardless */ }
    next();
  });
}
