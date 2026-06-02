import { Order, OrderDetail, CartItem } from './dinbendon';

export type BotStep =
  | 'idle'
  | 'selecting_order'
  | 'viewing_menu'
  | 'selecting_item'
  | 'entering_quantity'
  | 'entering_note'
  | 'reviewing_cart'
  | 'confirming';

export interface UserSession {
  chatId: number;
  step: BotStep;
  orders: Order[];
  selectedOrder?: Order;
  orderDetail?: OrderDetail;
  cart: CartItem[];
  /** The menu item currently being added */
  pendingItem?: {
    menuItemId: string;
    name: string;
    price: number;
    quantity?: number;
  };
  lastMessageId?: number;
}

export class SessionManager {
  private sessions = new Map<number, UserSession>();

  get(chatId: number): UserSession {
    if (!this.sessions.has(chatId)) {
      this.sessions.set(chatId, {
        chatId,
        step: 'idle',
        orders: [],
        cart: [],
      });
    }
    return this.sessions.get(chatId)!;
  }

  reset(chatId: number): void {
    this.sessions.set(chatId, {
      chatId,
      step: 'idle',
      orders: [],
      cart: [],
    });
  }

  update(chatId: number, updates: Partial<UserSession>): void {
    const session = this.get(chatId);
    Object.assign(session, updates);
  }
}
