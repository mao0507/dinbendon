import axios, { AxiosInstance } from 'axios';

export interface Order {
  id: string;
  title: string;
  shopName: string;
  deadline: string;
  organizer: string;
  orderUrl: string;
  detailUrl: string;
}

export interface MenuVariation {
  id: string;
  name: string | null;
  price: number;
}

export interface MenuProduct {
  id: string;
  name: string;
  variations: MenuVariation[];
}

export interface MenuCategory {
  name: string;
  products: MenuProduct[];
}

export interface OrderDetail {
  order: Order;
  categories: MenuCategory[];
  shopRevisionNo: number;
}

export interface MyOrderItem {
  productName: string;
  buyerName: string;
  qty: number;
  price: number;
  comment: string | null;
  orderItemIds: number[];
  cancelable: boolean;
}

const API_BASE = 'https://dinbendon.net/mvc/api';

function formatExpireDate(epochMs: number): string {
  const d = new Date(epochMs);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${min}`;
}

export class DinBenDonClient {
  private client: AxiosInstance;
  private token: string | null = null;
  private loggedIn = false;

  constructor() {
    this.client = axios.create({
      baseURL: API_BASE,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    });

    this.client.interceptors.request.use((config) => {
      if (this.token) config.headers.set('Authorization', `Bearer ${this.token}`);
      return config;
    });

    this.client.interceptors.response.use((response) => {
      const newToken = response.headers['x-dbd-new-token'];
      if (typeof newToken === 'string' && newToken !== '') this.token = newToken;
      return response;
    });
  }

  async login(username: string, password: string): Promise<void> {
    console.log('[DinBenDon] Logging in...');
    const resp = await this.client.post('/auth/login', {
      username,
      password,
      rememberMe: false,
      continueUrl: null,
    });

    const body = resp.data as { data: unknown; error: string | null };
    if (body.error) throw new Error(body.error);

    this.loggedIn = true;
    console.log('[DinBenDon] Login successful!');
  }

  async fetchOpenOrders(): Promise<Order[]> {
    if (!this.loggedIn) throw new Error('Not logged in');

    const resp = await this.client.get('/order/progress');
    const list = resp.data.data as Array<{
      orderHashId: string;
      shopName: string;
      expireDate: number | null;
      originator: string;
      inProgress: boolean;
    }>;

    return list
      .filter((o) => o.inProgress)
      .map((o) => ({
        id: o.orderHashId,
        title: o.shopName,
        shopName: o.shopName,
        deadline: o.expireDate ? formatExpireDate(o.expireDate) : '',
        organizer: o.originator,
        orderUrl: `https://dinbendon.net/do/order/${o.orderHashId}`,
        detailUrl: `https://dinbendon.net/do/order/${o.orderHashId}`,
      }));
  }

  async fetchOrderDetail(order: Order): Promise<OrderDetail> {
    if (!this.loggedIn) throw new Error('Not logged in');

    const resp = await this.client.post(`/order/${order.id}/get-add-item`, {
      fallbackPlayedBuyerName: null,
    });

    const data = resp.data.data as {
      shop: {
        revisionNo: number;
        categories: Array<{
          name: string;
          products: Array<{
            id: string;
            name: string;
            variations: Array<{ id: string; name: string | null; price: number }>;
          }>;
        }>;
      };
    };

    const categories: MenuCategory[] = data.shop.categories.map((cat) => ({
      name: cat.name,
      products: cat.products.map((p) => ({
        id: String(p.id),
        name: p.name,
        variations: p.variations.map((v) => ({ id: String(v.id), name: v.name, price: v.price })),
      })),
    }));

    return { order, categories, shopRevisionNo: data.shop.revisionNo };
  }

  async fetchMyItems(orderHashId: string): Promise<MyOrderItem[]> {
    if (!this.loggedIn) throw new Error('Not logged in');

    const resp = await this.client.get(`/order/${orderHashId}/product-group-for-buyer`, {
      params: { expand: false },
    });
    console.log('[DinBenDon] order-items raw:', JSON.stringify(resp.data.data).slice(0, 1000));

    const data = resp.data.data as {
      rows?: Array<{
        name?: string;
        mergedName?: string;
        mergedKey?: string;
        items?: Array<{
          name?: string;
          mergedName?: string;
          size?: number;
          total?: number;
          comment?: string | null;
          orderItemIds?: number[];
          cancelable?: boolean;
        }>;
      }>;
    };

    if (!data.rows) return [];

    return data.rows.flatMap((row) => {
      const productName = row.name ?? row.mergedName ?? row.mergedKey ?? '';
      return (row.items ?? []).map((item) => {
        const qty = item.size ?? 1;
        const total = item.total ?? 0;
        return {
          productName,
          buyerName: item.name ?? item.mergedName ?? '',
          qty,
          price: qty > 0 ? Math.round(total / qty) : 0,
          comment: item.comment ?? null,
          orderItemIds: item.orderItemIds ?? [],
          cancelable: item.cancelable ?? false,
        };
      });
    });
  }

  async cancelItem(orderHashId: string, orderItemIds: number[]): Promise<void> {
    if (!this.loggedIn) throw new Error('Not logged in');
    await this.client.post(`/order/${orderHashId}/cancel-item`, { orderItemIds });
  }

  async submitItem(
    orderDetail: OrderDetail,
    item: { menuItemId: string; productId: string; quantity: number; note?: string },
    buyerName: string
  ): Promise<boolean> {
    if (!this.loggedIn) throw new Error('Not logged in');

    let productName = '';
    let variationName: string | null = null;
    let categoryName: string | null = null;
    let price = 0;

    for (const cat of orderDetail.categories) {
      const product = cat.products.find((p) => String(p.id) === String(item.productId));
      if (product) {
        productName = product.name;
        categoryName = cat.name;
        const variation = product.variations.find((v) => v.id === item.menuItemId);
        if (variation) {
          variationName = variation.name || null;
          price = variation.price;
        }
        break;
      }
    }

    const numProductId = Number(item.productId);
    const numVariationId = Number(item.menuItemId);

    const payload = {
      playedName: buyerName,
      buyerInfo: null,
      addProducts: [{
        productId: Number.isNaN(numProductId) ? item.productId : numProductId,
        variationId: Number.isNaN(numVariationId) ? item.menuItemId : numVariationId,
        qty: item.quantity,
        comment: item.note || null,
        categoryName,
        productName,
        variationName,
        price,
      }],
      addMisc: null,
      shopRevisionNo: orderDetail.shopRevisionNo,
    };

    console.log('[DinBenDon] submit payload:', JSON.stringify(payload));

    const resp = await this.client.post(`/order/${orderDetail.order.id}/add-item`, payload).catch((e: unknown) => {
      const axiosErr = e as { response?: { status?: number; data?: unknown } };
      console.error('[DinBenDon] submit error:', axiosErr.response?.status, JSON.stringify(axiosErr.response?.data));
      throw e;
    });

    console.log('[DinBenDon] submit response:', JSON.stringify(resp.data));

    const body = resp.data as { data: unknown; error: string | null };
    if (body.error) {
      console.error('[DinBenDon] submit error:', body.error);
      return false;
    }

    return true;
  }

  isLoggedIn(): boolean {
    return this.loggedIn;
  }
}
