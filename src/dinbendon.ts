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

// 新點餐網站（https://w1323wwww-wq.github.io/dinbendon-web/）背後的 Cloudflare Worker，
// 用群組帳號代打 dinbendon.net API，路徑相同、回應同樣包在 { data, error }。
const WORKER_URL = 'https://dinbendon-proxy.w1323wwww.workers.dev';
// ponytail: Worker 只收來自網頁的 Origin，bot 自己帶；站長改檢查方式時這裡會壞（403 forbidden origin）
const WEB_ORIGIN = 'https://w1323wwww-wq.github.io';

function formatExpireDate(epochMs: number): string {
  const d = new Date(epochMs);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${min}`;
}

export const NO_ACCESS_CODE = '尚未設定通關碼，請聯絡管理員';
export const BAD_ACCESS_CODE = '通關碼失效，請聯絡管理員';

/** Worker 用來判斷「誰能取消哪些品項」；ponytail: 固定字串、猜得到，歸屬以 DB 為準 */
const ownerKey = (userId?: number): string => (userId === undefined ? 'tg-bot' : `tg-${userId}`);

export interface DinBenDonClientOptions {
  /** 每次請求讀一次，改通關碼立即生效；null 表示尚未設定 */
  getAccessCode: () => string | null;
  /** 測試用：注入假的 HTTP 處理函式 */
  adapter?: AxiosRequestConfig['adapter'];
}

export class DinBenDonClient {
  private client: AxiosInstance;

  constructor(options: DinBenDonClientOptions) {
    this.client = axios.create({
      baseURL: WORKER_URL,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Origin: WEB_ORIGIN },
      adapter: options.adapter,
    });

    this.client.interceptors.request.use((config: InternalAxiosRequestConfig) => {
      if (!config.headers.has('X-Access-Code')) {
        const code = options.getAccessCode();
        if (!code) throw new Error(NO_ACCESS_CODE);
        config.headers.set('X-Access-Code', code);
      }
      if (!config.headers.has('X-Owner-Key')) config.headers.set('X-Owner-Key', ownerKey());
      return config;
    });

    this.client.interceptors.response.use(undefined, (error: unknown) => {
      const res = (error as { response?: { status?: number; data?: { error?: unknown } } }).response;
      if (res?.status === 401) return Promise.reject(new Error(BAD_ACCESS_CODE));
      if (typeof res?.data?.error === 'string' && res.data.error) return Promise.reject(new Error(res.data.error));
      return Promise.reject(error);
    });
  }

  /** 用指定通關碼試打一次；碼錯回 false，其他錯誤（網路、Origin 被擋）照丟。 */
  async verifyAccessCode(code: string): Promise<boolean> {
    try {
      await this.client.get('/order/progress', { headers: { 'X-Access-Code': code } });
      return true;
    } catch (err) {
      if (err instanceof Error && err.message === BAD_ACCESS_CODE) return false;
      throw err;
    }
  }

  async fetchOpenOrders(): Promise<Order[]> {
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
        orderUrl: `https://w1323wwww-wq.github.io/dinbendon-web/#/order/${o.orderHashId}`,
        detailUrl: `https://w1323wwww-wq.github.io/dinbendon-web/#/order/${o.orderHashId}`,
      }));
  }

  async fetchOrderDetail(order: Order): Promise<OrderDetail> {
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

  /** 整團的品項（Worker 的 `buyer` 欄位不可靠，歸屬由 Submissions 依 DB 判斷）。 */
  async fetchMyItems(orderHashId: string): Promise<MyOrderItem[]> {
    const resp = await this.client.get(`/order/${orderHashId}/expand-for-buyer`);
    const items = (resp.data.data?.items ?? []) as Array<{
      id: number;
      buyerName: string;
      productFullName: string;
      comment: string | null;
      price: number;
      calculatedPrice?: number | null;
      paid?: boolean;
      shipped?: boolean;
    }>;

    // 同人、同品項、同備註、同價合併成一列（跟網頁版一樣）
    const lines = new Map<string, MyOrderItem>();
    for (const it of items) {
      const key = `${it.buyerName}|${it.productFullName}|${it.comment ?? ''}|${it.price}`;
      let line = lines.get(key);
      if (!line) {
        line = {
          productName: it.productFullName,
          buyerName: it.buyerName,
          qty: 0,
          price: it.calculatedPrice ?? it.price,
          comment: it.comment || null,
          orderItemIds: [],
          cancelable: true,
        };
        lines.set(key, line);
      }
      line.qty++;
      line.orderItemIds.push(it.id);
      if (it.paid || it.shipped) line.cancelable = false;
    }
    return [...lines.values()];
  }

  async cancelItem(orderHashId: string, orderItemIds: number[], userId?: number): Promise<void> {
    await this.client.post(`/order/${orderHashId}/cancel-item`, { orderItemIds }, {
      headers: { 'X-Owner-Key': ownerKey(userId) },
    });
  }

  async submitItem(
    orderDetail: OrderDetail,
    item: { menuItemId: string; productId: string; quantity: number; note?: string },
    buyerName: string,
    userId?: number,
  ): Promise<boolean> {
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

    const resp = await this.client.post(`/order/${orderDetail.order.id}/add-item`, payload, {
      headers: { 'X-Owner-Key': ownerKey(userId) },
    }).catch((e: unknown) => {
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
