import axios, { AxiosInstance } from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import * as cheerio from 'cheerio';

export interface Order {
  id: string;
  title: string;
  shopName: string;
  deadline: string;
  organizer: string;
  orderUrl: string;
  /** Wicket URL for the order detail page */
  detailUrl: string;
}

export interface MenuItem {
  id: string;
  name: string;
  price: number;
  description?: string;
}

export interface CartItem {
  menuItemId: string;
  name: string;
  price: number;
  quantity: number;
  note?: string;
}

export interface OrderDetail {
  order: Order;
  menuItems: MenuItem[];
  /** Current user's existing items in this order */
  myItems: CartItem[];
  /** Wicket form data needed to submit */
  formData: Record<string, string>;
}

const BASE_URL = 'https://dinbendon.net/do';

export class DinBenDonClient {
  private client: AxiosInstance;
  private jar: CookieJar;
  private loggedIn = false;

  constructor() {
    this.jar = new CookieJar();
    this.client = wrapper(
      axios.create({
        baseURL: BASE_URL,
        jar: this.jar,
        withCredentials: true,
        maxRedirects: 10,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
        },
      })
    );
  }

  /**
   * Login to DinBenDon.
   * Single GET to fetch login page, then POST to the form's actual action URL.
   */
  async login(username: string, password: string): Promise<void> {
    console.log('[DinBenDon] Fetching login page...');
    const pageResp = await this.client.get('/');
    const sessionUrl: string =
      (pageResp.request as { res?: { responseUrl?: string } }).res?.responseUrl ??
      (pageResp.config.url as string | undefined) ??
      BASE_URL + '/';
    const html = pageResp.data as string;
    const $ = cheerio.load(html);

    let userField = '';
    let passField = '';
    let calcField = '';
    let calcAnswer = '';

    const captchaMatch = html.match(/(\d+)\s*([+\-])\s*(\d+)\s*=/);
    if (captchaMatch) {
      const [, a, op, b] = captchaMatch;
      calcAnswer = op === '+' ? String(parseInt(a) + parseInt(b)) : String(parseInt(a) - parseInt(b));
    }

    $('form input').each((_, el) => {
      const type = $(el).attr('type') ?? 'text';
      const name = $(el).attr('name') ?? '';
      const id = $(el).attr('id') ?? '';
      const placeholder = $(el).attr('placeholder') ?? '';
      const combined = (name + id + placeholder).toLowerCase();

      if (type === 'hidden') return;

      if (combined.includes('user') || combined.includes('name') || combined.includes('account')) {
        userField = name;
      } else if (combined.includes('pass') || combined.includes('pwd')) {
        passField = name;
      } else if (combined.includes('calc') || combined.includes('captcha') || combined.includes('answer')) {
        calcField = name;
      }
    });

    // Positional fallback
    if (!userField || !passField) {
      let textCount = 0;
      $('form input').each((_, el) => {
        const type = $(el).attr('type') ?? 'text';
        const name = $(el).attr('name') ?? '';
        if (!name) return;
        if (type === 'text' && !userField) { userField = name; textCount++; }
        else if (type === 'text' && textCount === 1 && !calcField) { calcField = name; textCount++; }
        else if (type === 'password' && !passField) { passField = name; }
      });
    }

    const formBody = new URLSearchParams();
    $('form input[type="hidden"]').each((_, el) => {
      const name = $(el).attr('name');
      const value = $(el).attr('value') ?? '';
      if (name) formBody.append(name, value);
    });
    $('form select').each((_, el) => {
      const name = $(el).attr('name');
      const value = $(el).find('option[selected]').attr('value') ?? $(el).find('option').first().attr('value') ?? '';
      if (name) formBody.append(name, value);
    });

    if (userField) formBody.set(userField, username);
    if (passField) formBody.set(passField, password);
    if (calcField && calcAnswer) formBody.set(calcField, calcAnswer);

    // Resolve form action relative to the actual page URL (handles Wicket ?wicket:interface=... params)
    const rawAction = $('form').attr('action') ?? '';
    const submitUrl = rawAction ? new URL(rawAction, sessionUrl).href : sessionUrl;

    console.log(`[DinBenDon] Submitting login to ${submitUrl}`);
    const loginResp = await this.client.post(submitUrl, formBody.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      maxRedirects: 10,
    });

    const $after = cheerio.load(loginResp.data as string);
    const pageText = loginResp.data as string;

    const isLoggedIn =
      pageText.includes('logout') ||
      pageText.includes('登出') ||
      pageText.includes('管理中心') ||
      pageText.includes('management') ||
      $after('a[href*="logout"]').length > 0;

    if (!isLoggedIn) {
      const errorMsg = $after('.feedbackPanelERROR, .error, [class*="error"]').first().text().trim();
      throw new Error(`Login failed: ${errorMsg || 'Unknown error - please check credentials'}`);
    }

    this.loggedIn = true;
    console.log('[DinBenDon] Login successful!');
  }

  /** Fetch the list of open orders the user can participate in */
  async fetchOpenOrders(): Promise<Order[]> {
    if (!this.loggedIn) throw new Error('Not logged in');

    // Navigate to the main page / order list
    const resp = await this.client.get('/');
    const $ = cheerio.load(resp.data as string);
    const orders: Order[] = [];

    // DinBenDon shows active orders on the dashboard
    // Look for order links/cards — they typically have class like "order", "purchase", etc.
    // The order link text usually contains shop name and deadline

    // Try multiple selectors for order listings
    const selectors = [
      'a[href*="order"]',
      'a[href*="purchase"]',
      'a[href*="OrderPage"]',
      '.order-item a',
      'td a[href*="wicket"]',
    ];

    const foundUrls = new Set<string>();

    for (const sel of selectors) {
      $(sel).each((_, el) => {
        const href = $(el).attr('href') ?? '';
        if (!href || foundUrls.has(href)) return;
        const text = $(el).text().trim();
        if (!text) return;
        foundUrls.add(href);

        const fullUrl = href.startsWith('http') ? href : BASE_URL + href;
        orders.push({
          id: href,
          title: text,
          shopName: text,
          deadline: '',
          organizer: '',
          orderUrl: fullUrl,
          detailUrl: fullUrl,
        });
      });
    }

    // Also check for a dedicated "current orders" page
    if (orders.length === 0) {
      const links = ['/manage', '/manage/home', '/manage/order'];
      for (const link of links) {
        try {
          const r = await this.client.get(link);
          const $r = cheerio.load(r.data as string);
          $r('a').each((_, el) => {
            const href = $r(el).attr('href') ?? '';
            const text = $r(el).text().trim();
            if (href.includes('order') || href.includes('purchase') || href.includes('Order')) {
              const fullUrl = href.startsWith('http') ? href : BASE_URL + href;
              if (!foundUrls.has(href) && text) {
                foundUrls.add(href);
                orders.push({
                  id: href,
                  title: text,
                  shopName: text,
                  deadline: '',
                  organizer: '',
                  orderUrl: fullUrl,
                  detailUrl: fullUrl,
                });
              }
            }
          });
          if (orders.length > 0) break;
        } catch {
          // ignore
        }
      }
    }

    // Parse structured order data if present
    return this.parseOrderList($, resp.data as string, orders);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private parseOrderList($: any, html: string, fallback: Order[]): Order[] {
    const orders: Order[] = [];

    // Look for table rows or cards with order info
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $('tr, .order-row, .purchase-row, [class*="order"]').each((_: any, row: any) => {
      const $row = $(row);
      const links = $row.find('a');
      if (links.length === 0) return;

      const mainLink = links.first();
      const href = mainLink.attr('href') ?? '';
      if (!href) return;

      const cells = $row.find('td');
      const shopName = cells.eq(0).text().trim() || mainLink.text().trim();
      const deadline = cells.eq(1).text().trim() || cells.eq(2).text().trim() || '';
      const organizer = cells.eq(3).text().trim() || '';

      if (!shopName) return;

      const fullUrl = href.startsWith('http') ? href : BASE_URL + href;
      orders.push({
        id: href,
        title: shopName,
        shopName,
        deadline,
        organizer,
        orderUrl: fullUrl,
        detailUrl: fullUrl,
      });
    });

    return orders.length > 0 ? orders : fallback;
  }

  /** Fetch detail of a specific order including menu items */
  async fetchOrderDetail(order: Order): Promise<OrderDetail> {
    if (!this.loggedIn) throw new Error('Not logged in');

    const resp = await this.client.get(order.detailUrl);
    const $ = cheerio.load(resp.data as string);
    const menuItems: MenuItem[] = [];
    const myItems: CartItem[] = [];
    const formData: Record<string, string> = {};

    // Collect hidden form fields
    $('form input[type="hidden"]').each((_, el) => {
      const name = $(el).attr('name');
      const value = $(el).attr('value') ?? '';
      if (name) formData[name] = value;
    });

    // Parse menu items: usually in a table or list
    // Each row has: item name, price, (qty input)
    $('table tr, .menu-item, [class*="item"]').each((idx, row) => {
      const $row = $(row);
      const cells = $row.find('td');
      if (cells.length < 2) return;

      const nameCell = cells.eq(0).text().trim();
      const priceText = cells.eq(1).text().trim().replace(/[^\d]/g, '');
      const price = parseInt(priceText) || 0;

      if (!nameCell || nameCell === '品名' || nameCell === '名稱' || nameCell === 'Item') return;

      const id = `item-${idx}`;
      menuItems.push({ id, name: nameCell, price, description: cells.eq(2).text().trim() || undefined });
    });

    // If table parsing fails, try list items
    if (menuItems.length === 0) {
      $('li, .product').each((idx, el) => {
        const $el = $(el);
        const text = $el.text().trim();
        const priceMatch = text.match(/\$?\s*(\d+)/);
        if (!priceMatch) return;
        const price = parseInt(priceMatch[1]);
        const name = text.replace(/\$?\s*\d+.*/, '').trim();
        if (name) {
          menuItems.push({ id: `item-${idx}`, name, price });
        }
      });
    }

    // Parse my existing items in this order
    $('[class*="my"], [class*="mine"], .my-order tr').each((_, row) => {
      const $row = $(row);
      const cells = $row.find('td');
      if (cells.length < 2) return;
      const name = cells.eq(0).text().trim();
      const priceText = cells.eq(1).text().trim().replace(/[^\d]/g, '');
      const price = parseInt(priceText) || 0;
      if (name && price) {
        myItems.push({ menuItemId: name, name, price, quantity: 1 });
      }
    });

    return { order, menuItems, myItems, formData };
  }

  /**
   * Submit order for a specific order.
   * items: array of { menuItemId, quantity, note }
   */
  async submitOrder(
    orderDetail: OrderDetail,
    items: { menuItemId: string; quantity: number; note?: string }[]
  ): Promise<boolean> {
    if (!this.loggedIn) throw new Error('Not logged in');

    // Re-fetch the order page to get fresh form state
    const resp = await this.client.get(orderDetail.order.detailUrl);
    const $ = cheerio.load(resp.data as string);

    const formData = new URLSearchParams();

    // Add all hidden fields
    $('form input[type="hidden"]').each((_, el) => {
      const name = $(el).attr('name');
      const value = $(el).attr('value') ?? '';
      if (name) formData.append(name, value);
    });

    // Add selected items
    // DinBenDon uses checkboxes or quantity inputs per item
    $('form input[type="checkbox"], form input[type="number"], form select').each((_, el) => {
      const $el = $(el);
      const name = $el.attr('name') ?? '';
      if (!name) return;

      // Check if this input corresponds to one of our selected items
      const rowText = $el.closest('tr, li, .item').text().toLowerCase();
      const matchedItem = items.find(
        (item) => rowText.includes(item.menuItemId.toLowerCase()) || rowText.includes(item.menuItemId)
      );

      if (matchedItem) {
        const tagName = (el as { tagName: string }).tagName;
        if (tagName === 'input' && $el.attr('type') === 'checkbox') {
          formData.set(name, 'on');
        } else if (tagName === 'input' && $el.attr('type') === 'number') {
          formData.set(name, String(matchedItem.quantity));
        } else if (tagName === 'select') {
          formData.set(name, String(matchedItem.quantity));
        }
      }
    });

    // Add notes
    $('form textarea, form input[type="text"][name*="note"], form input[type="text"][name*="memo"]').each((_, el) => {
      const $el = $(el);
      const name = $el.attr('name') ?? '';
      if (!name) return;
      const rowText = $el.closest('tr, li, .item').text();
      const matchedItem = items.find((item) => rowText.includes(item.menuItemId));
      if (matchedItem?.note) formData.set(name, matchedItem.note);
    });

    // Find submit button name/value (Wicket needs it)
    $('form input[type="submit"], form button[type="submit"]').each((_, el) => {
      const name = $(el).attr('name');
      const value = $(el).attr('value') ?? '訂';
      if (name) formData.set(name, value);
    });

    const formAction = $('form').attr('action') ?? orderDetail.order.detailUrl;
    const submitUrl = formAction.startsWith('http') ? formAction : BASE_URL + formAction;

    const submitResp = await this.client.post(submitUrl, formData.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    // Check for success indication
    const resultText = submitResp.data as string;
    const $result = cheerio.load(resultText);
    const successMsg = $result('[class*="success"], .ok, [class*="info"]').text();
    const errorMsg = $result('[class*="error"], .feedbackPanelERROR').text().trim();

    if (errorMsg) {
      console.error('[DinBenDon] Submit error:', errorMsg);
      return false;
    }

    return true;
  }

  isLoggedIn(): boolean {
    return this.loggedIn;
  }
}
