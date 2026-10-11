type WooProduct = {
  id: number;
  name: string;
  price: string;
  regular_price: string;
  status: string;
  permalink: string;
  stock_status?: string;
};

type WooOrder = {
  id: number;
  status: string;
  total: string;
  currency: string;
  date_created: string;
  billing?: { first_name?: string; last_name?: string; email?: string };
  line_items?: { name: string; quantity: number; total: string }[];
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env ${name}`);
  return value;
}

const baseUrl = required("WOO_BASE_URL").replace(/\/$/, "");
const publicHost = required("WOO_PUBLIC_HOST");
const consumerKey = required("WOO_CONSUMER_KEY");
const consumerSecret = required("WOO_CONSUMER_SECRET");

function summarizeProduct(product: WooProduct) {
  return {
    id: product.id,
    name: product.name,
    price: product.price,
    regular_price: product.regular_price,
    status: product.status,
    permalink: product.permalink,
    stock_status: product.stock_status,
  };
}

function summarizeOrder(order: WooOrder) {
  return {
    id: order.id,
    status: order.status,
    total: order.total,
    currency: order.currency,
    created: order.date_created,
    billing: {
      first_name: order.billing?.first_name,
      last_name: order.billing?.last_name,
      email: order.billing?.email,
    },
    line_items: (order.line_items ?? []).map((item) => ({
      name: item.name,
      quantity: item.quantity,
      total: item.total,
    })),
  };
}

async function woo<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64")}`);
  headers.set("Content-Type", "application/json");
  // wp-config copies X-Forwarded-Host into HTTP_HOST so REST stays on the Service.
  // X-Forwarded-Proto https makes is_ssl() true so WooCommerce accepts API keys.
  headers.set("X-Forwarded-Host", publicHost);
  headers.set("X-Forwarded-Proto", "https");

  const splitAt = path.indexOf("?");
  const pathname = splitAt === -1 ? path : path.slice(0, splitAt);
  const query = splitAt === -1 ? "" : path.slice(splitAt + 1);
  const prettyUrl = `${baseUrl}/wp-json/wc/v3${pathname}${query ? `?${query}` : ""}`;
  const fallbackUrl = `${baseUrl}/index.php?rest_route=${encodeURIComponent(`/wc/v3${pathname}`)}${query ? `&${query}` : ""}`;
  const pretty = await fetch(prettyUrl, { ...init, headers });
  const response = pretty.status === 404 ? await fetch(fallbackUrl, { ...init, headers }) : pretty;
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`WooCommerce ${response.status}: ${text.slice(0, 400)}`);
  }
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export async function wooReady(): Promise<boolean> {
  try {
    await woo<unknown>("/products?per_page=1");
    return true;
  } catch {
    return false;
  }
}

export async function listProducts(search?: string, perPage = 20) {
  const params = new URLSearchParams({ per_page: String(perPage), status: "publish" });
  if (search) params.set("search", search);
  const products = await woo<WooProduct[]>(`/products?${params}`);
  return products.map(summarizeProduct);
}

export async function createProduct(input: { name: string; regularPrice: string; description?: string }) {
  const product = await woo<WooProduct>("/products", {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      type: "simple",
      regular_price: input.regularPrice,
      description: input.description ?? "",
      status: "publish",
    }),
  });
  return summarizeProduct(product);
}

export async function listOrders(input: { after?: string; before?: string; status?: string; perPage?: number }) {
  const params = new URLSearchParams({
    per_page: String(input.perPage ?? 20),
    orderby: "date",
    order: "desc",
  });
  if (input.after) params.set("after", input.after);
  if (input.before) params.set("before", input.before);
  if (input.status) params.set("status", input.status);
  const orders = await woo<WooOrder[]>(`/orders?${params}`);
  return orders.map(summarizeOrder);
}

export async function getOrder(id: number) {
  const order = await woo<WooOrder>(`/orders/${id}`);
  return summarizeOrder(order);
}

export async function updateOrderStatus(id: number, status: string) {
  const order = await woo<WooOrder>(`/orders/${id}`, {
    method: "PUT",
    body: JSON.stringify({ status }),
  });
  return summarizeOrder(order);
}
