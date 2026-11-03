import axios, { AxiosInstance, AxiosRequestConfig, InternalAxiosRequestConfig } from 'axios';

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

/** 登入失敗。message 直接給使用者看；網站的原始錯誤放 detail 並寫 log。 */
export class LoginError extends Error {
  constructor(readonly detail?: unknown) {
    super('無法登入訂便當系統，請稍後再試。若持續發生請聯絡管理員。');
    this.name = 'LoginError';
  }
}

export interface DinBenDonClientOptions {
  username: string;
  password: string;
  /** 登入失敗後多久內不再打登入端點，預設 30 秒 */
  cooldownMs?: number;
  /** 測試用：注入假的 HTTP 處理函式 */
  adapter?: AxiosRequestConfig['adapter'];
}

type Cfg = InternalAxiosRequestConfig & { _retried?: boolean; _token?: string | null };

export class DinBenDonClient {
  private client: AxiosInstance;
  private token: string | null = null;
  private readonly username: string;
  private readonly password: string;
  private readonly cooldownMs: number;
  /** 目前（或進行中）的登入；null 表示尚未登入或需要重登 */
  private session: Promise<void> | null = null;
  private reauthing: Promise<void> | null = null;
  private lastFailure: { at: number; error: LoginError } | null = null;

  constructor(options: DinBenDonClientOptions) {
    this.username = options.username;
    this.password = options.password;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.client = axios.create({
      baseURL: API_BASE,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      adapter: options.adapter,
    });

    this.client.interceptors.request.use((config: Cfg) => {
      config._token = this.token;
      if (this.token) config.headers.set('Authorization', `Bearer ${this.token}`);
      return config;
    });

    this.client.interceptors.response.use(
      (response) => {
        const newToken = response.headers['x-dbd-new-token'];
        if (typeof newToken === 'string' && newToken !== '') this.token = newToken;
        return response;
      },
      async (error: unknown) => {
        const axiosErr = error as { response?: { status?: number }; config?: Cfg };
        const config = axiosErr.config;
        if (axiosErr.response?.status === 401 && config && !config._retried) {
          config._retried = true;
          // 請求送出後 token 已被別人換新，直接用新 token 重試，不必再登入
          if (config._token === this.token) await this.reauth();
          return this.client(config);
        }
        return Promise.reject(error);
      },
    );
  }

  /** 確保已登入。第一次呼叫才登入；同時多個呼叫共用同一次登入。 */
  ready(): Promise<void> {
    if (this.session) return this.session;
    const failure = this.lastFailure;
    if (failure && Date.now() - failure.at < this.cooldownMs) return Promise.reject(failure.error);

    const attempt = this.doLogin().then(
      () => { this.lastFailure = null; },
      (error: LoginError) => {
        this.session = null;
        this.lastFailure = { at: Date.now(), error };
        throw error;
      },
    );
    this.session = attempt;
    return attempt;
  }

  /** token 失效：所有並發的 401 共用同一次重登。 */
  private reauth(): Promise<void> {
    if (!this.reauthing) {
      this.session = null;
      this.reauthing = this.ready().finally(() => { this.reauthing = null; });
    }
    return this.reauthing;
  }

  private async doLogin(): Promise<void> {
    console.log('[DinBenDon] Logging in...');
    try {
      // _retried：登入請求本身的 401 不要再觸發重登
      const resp = await this.client.post(
        '/auth/login',
        { username: this.username, password: this.password, rememberMe: false, continueUrl: null },
        { _retried: true } as unknown as AxiosRequestConfig,
      );
      const body = resp.data as { data: unknown; error: string | null };
      if (body.error) throw new Error(body.error);
      console.log('[DinBenDon] Login successful!');
    } catch (err) {
      console.error('[DinBenDon] Login failed:', err instanceof Error ? err.message : err);
      throw new LoginError(err);
    }
  }

  async fetchOpenOrders(): Promise<Order[]> {
    await this.ready();

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
    await this.ready();

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
    await this.ready();

    const resp = await this.client.get(`/order/${orderHashId}/product-group-for-buyer`, {
      params: { expand: false },
    });

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
    await this.ready();
    await this.client.post(`/order/${orderHashId}/cancel-item`, { orderItemIds });
  }

  async submitItem(
    orderDetail: OrderDetail,
    item: { menuItemId: string; productId: string; quantity: number; note?: string },
    buyerName: string
  ): Promise<boolean> {
    await this.ready();

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
}
