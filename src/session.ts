import { Order, OrderDetail, MenuVariation } from './dinbendon';

export type BotStep =
  | 'idle'
  | 'selecting_order'
  | 'selecting_category'
  | 'selecting_item'
  | 'selecting_variation'
  | 'entering_quantity'
  | 'entering_note'
  | 'entering_buyer_name';

export interface UserSession {
  chatId: number;
  step: BotStep;
  orders: Order[];
  selectedOrder?: Order;
  orderDetail?: OrderDetail;
  selectedCategoryIdx?: number;
  pendingProduct?: {
    productId: string;
    productName: string;
    variations: MenuVariation[];
  };
  pendingItem?: {
    menuItemId: string;
    productId: string;
    name: string;
    price: number;
    quantity?: number;
    note?: string;
  };
}

export class SessionManager {
  private sessions = new Map<number, UserSession>();

  get(chatId: number): UserSession {
    if (!this.sessions.has(chatId)) {
      this.sessions.set(chatId, { chatId, step: 'idle', orders: [] });
    }
    return this.sessions.get(chatId)!;
  }

  reset(chatId: number): void {
    this.sessions.set(chatId, { chatId, step: 'idle', orders: [] });
  }

  update(chatId: number, updates: Partial<UserSession>): void {
    const session = this.get(chatId);
    Object.assign(session, updates);
  }
}
