import { randomInt } from "node:crypto";
import { envOr } from "@sangam/shared";
import { KNOWN_ROUTES, bookTicket } from "../../merchant-api/src/service.ts";
import { esc } from "./pages.ts";

/** Query-string values, as Express and x402 hand them over. */
export type Query = Record<string, unknown>;

/** What a shop returns for a paid request. An error status means x402 won't settle, so the buyer isn't charged. */
export type Delivery = { status?: number; body: Record<string, unknown> };

/**
 * One test shop. Its price, Hedera payTo and UPI ID come from its ENS records
 * (or data/merchants.local.json while ENS_OFFLINE=true), like any Sangam merchant.
 */
export type Shop = {
  slug: string;
  ensName: string;
  title: string;
  sells: string;
  /** Which part of Sangam this shop puts under stress. */
  tests: string;
  accent: string;
  /** The x402-protected route agents pay for. */
  buyPath: string;
  /** Example query for the paid route, e.g. "id=2". */
  example: string;
  /** How many purchases the suggested `npm run buy` makes. */
  agentCount: number;
  /** Arguments for `npm run simulate` (count first), or null if this test needs a real payment. */
  simArgs: string | null;
  /** Reject a bad request before asking for payment. Returns an error message, or null if it's fine. */
  check?: (query: Query) => string | null;
  /** This request's price in paise. Leave out to charge the listed ENS price. */
  pricePaise?: (query: Query) => number;
  /** Hand over the goods. Runs only after x402 has verified the payment. */
  deliver: (query: Query) => Delivery;
  /** Extra live facts for /quote. */
  extras?: () => Record<string, unknown>;
  /** Extra HTML for the shop's page. */
  pageExtra?: () => string;
  /** Buttons on the shop's page, each served as POST /<slug>/<name>. */
  actions?: Record<string, () => void>;
};

/** First value of a query parameter, if it was sent. */
function param(query: Query, key: string): string | undefined {
  const value = query[key];
  if (Array.isArray(value)) return value[0] === undefined ? undefined : String(value[0]);
  return typeof value === "string" ? value : undefined;
}

const today = () => new Date().toISOString().slice(0, 10);

// Every shop is a subname of one ENS name, e.g. news.sangam.eth.
// Once live, set SHOPS_ENS_PARENT to the name you registered.
const parent = envOr("SHOPS_ENS_PARENT", "sangam.eth");

// ── 1. Rail tickets: the normal case ────────────────────────────────

const rail: Shop = {
  slug: "rail",
  ensName: `rail.${parent}`,
  title: "Rail Tickets",
  sells: "Train tickets at one fixed price",
  tests: "The normal case. One purchase at the listed price should end as paid. Use it as your baseline.",
  accent: "#2563eb",
  buyPath: "/rail/book",
  example: "from=CSMT&to=PUNE",
  agentCount: 1,
  simArgs: "1",
  deliver(query) {
    const ticket = bookTicket({
      from: param(query, "from") ?? "CSMT",
      to: param(query, "to") ?? "PUNE",
      date: param(query, "date") ?? today(),
    });
    return { body: { ...ticket, summary: `PNR ${ticket.pnr} · ${ticket.train.name} · ${ticket.coach}/${ticket.seat}` } };
  },
  pageExtra: () =>
    `<p>Routes: ${KNOWN_ROUTES.map((r) => `<code>${esc(r)}</code>`).join(" ")}. Any other route books the Deccan Express.</p>`,
};

// ── 2. News: tiny payments ──────────────────────────────────────────

const ARTICLES = [
  { id: "1", title: "Mumbai local adds 12 new AC services", body: "Western Railway will run 12 more air-conditioned locals from next month, mostly in the morning peak." },
  { id: "2", title: "Monsoon arrives early in Kerala", body: "The weather department says the monsoon reached the coast four days ahead of schedule." },
  { id: "3", title: "UPI crosses another monthly record", body: "Payments over UPI hit a new high last month, led by small merchant transactions." },
  { id: "4", title: "Pune metro extends late-night hours", body: "Trains on both lines will now run until midnight on weekends." },
  { id: "5", title: "Chai prices steady despite milk hike", body: "Most tea stalls say they will absorb the cost for now rather than raise prices." },
];

const news: Shop = {
  slug: "news",
  ensName: `news.${parent}`,
  title: "Paisa News",
  sells: "Single news articles, pay per read",
  tests: "Tiny payments. Does the currency conversion, rounding and fee maths still work when the whole payment is ₹2?",
  accent: "#b45309",
  buyPath: "/news/article",
  example: "id=1",
  agentCount: 3,
  simArgs: "3",
  check: (query) =>
    ARTICLES.some((a) => a.id === param(query, "id")) ? null : `Unknown article. Use ?id=1 to ?id=${ARTICLES.length}.`,
  deliver(query) {
    const article = ARTICLES.find((a) => a.id === param(query, "id"))!;
    return { body: { ...article, summary: `article #${article.id}: ${article.title}` } };
  },
  pageExtra: () =>
    `<ol>${ARTICLES.map((a) => `<li>${esc(a.title)} <small>(?id=${esc(a.id)})</small></li>`).join("")}</ol>`,
};

// ── 3. Weather API: many fast payments ──────────────────────────────

const CONDITIONS = ["sunny", "humid", "cloudy", "light rain", "thunderstorms", "hazy"];

const weather: Shop = {
  slug: "weather",
  ensName: `weather.${parent}`,
  title: "Monsoon Weather API",
  sells: "Current weather for any Indian city, ₹1 per call",
  tests:
    "Lots of fast payments. More than 5 payments in one minute from the same buyer counts as a runaway agent, so payments 6 onwards should be held. The simulator sends all 8 at once, and then Sangam holds all 8, even the first 5.",
  accent: "#0f766e",
  buyPath: "/weather/now",
  example: "city=Mumbai",
  agentCount: 8,
  simArgs: "8",
  deliver(query) {
    const city = param(query, "city") ?? "Mumbai";
    const tempC = randomInt(22, 37);
    const condition = CONDITIONS[randomInt(CONDITIONS.length)]!;
    return {
      body: { city, tempC, condition, humidity: randomInt(40, 91), summary: `${city}: ${tempC}°C, ${condition}` },
    };
  },
  pageExtra: () => `<p>Any city works, e.g. <code>?city=Delhi</code>. The weather is made up.</p>`,
};

// ── 4. Food ordering: the price changes per order ───────────────────

// Prices in paise. Kept under ₹88 (about $1) so a single item fits the
// buyer's default CUSTOMER_MAX_PER_PAYMENT cap.
const MENU: Record<string, number> = { chai: 2000, samosa: 1500, "vada-pav": 2500, lassi: 4000, thali: 8000 };

function orderItems(query: Query): string[] {
  return (param(query, "items") ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

const orderPaise = (items: string[]) => items.reduce((sum, item) => sum + (MENU[item] ?? 0), 0);

const food: Shop = {
  slug: "food",
  ensName: `food.${parent}`,
  title: "Tapri Kitchen",
  sells: "Street food orders, priced by what's in the cart",
  tests:
    "Prices that change per order. Sangam checks every payment against one listed price (₹60), so a ₹20 chai looks like an underpayment and gets held, while a ₹80 thali goes through.",
  accent: "#c2410c",
  buyPath: "/food/order",
  example: "items=chai",
  agentCount: 1,
  simArgs: "1 --inr 20",
  check(query) {
    const items = orderItems(query);
    if (items.length === 0) return `Add items, e.g. ?items=chai,samosa. Menu: ${Object.keys(MENU).join(", ")}.`;
    const unknown = items.filter((item) => !(item in MENU));
    return unknown.length > 0 ? `Not on the menu: ${unknown.join(", ")}.` : null;
  },
  pricePaise: (query) => orderPaise(orderItems(query)),
  deliver(query) {
    const items = orderItems(query);
    const totalInr = orderPaise(items) / 100;
    const orderId = String(randomInt(100_000, 999_999));
    return {
      body: { orderId, items, totalInr, eta: `${randomInt(15, 41)} min`, summary: `order #${orderId}: ${items.join(", ")} (₹${totalInr})` },
    };
  },
  extras: () => ({ menuInr: Object.fromEntries(Object.entries(MENU).map(([item, paise]) => [item, paise / 100])) }),
  pageExtra: () =>
    `<table><thead><tr><th>Item</th><th>Price</th></tr></thead><tbody>${Object.entries(MENU)
      .map(([item, paise]) => `<tr><td><code>${esc(item)}</code></td><td>₹${paise / 100}</td></tr>`)
      .join("")}</tbody></table><p>Order several with commas: <code>?items=chai,samosa,vada-pav</code>.</p>`,
};

// ── 5. Concert tickets: the shop fails after the agent pays ─────────

const STOCK = 3;
let ticketsLeft = STOCK;

const concert: Shop = {
  slug: "concert",
  ensName: `concert.${parent}`,
  title: "Indie Night Tickets",
  sells: `Concert tickets, only ${STOCK} available`,
  tests: `The shop failing after the agent pays. Once the ${STOCK} tickets are gone, the next buyer gets an error and must not be charged.`,
  accent: "#7c3aed",
  buyPath: "/concert/ticket",
  example: "",
  agentCount: STOCK + 1,
  simArgs: null,
  deliver() {
    // Checked after payment on purpose: x402 cancels the settlement when the
    // shop answers with an error, and that's what this shop is here to test.
    if (ticketsLeft === 0) {
      return { status: 410, body: { error: "Sold out. The shop couldn't deliver, so x402 didn't settle the payment." } };
    }
    ticketsLeft--;
    const ticketId = `IN-${randomInt(10_000, 99_999)}`;
    return { body: { ticketId, event: "Indie Night", entry: "General admission", ticketsLeft, summary: `ticket ${ticketId} · ${ticketsLeft} left` } };
  },
  extras: () => ({ ticketsLeft, stock: STOCK }),
  pageExtra: () => `<p class="stock"><strong>${ticketsLeft}</strong> of ${STOCK} tickets left.</p>`,
  actions: {
    restock: () => {
      ticketsLeft = STOCK;
    },
  },
};

export const SHOPS: Shop[] = [rail, news, weather, food, concert];
