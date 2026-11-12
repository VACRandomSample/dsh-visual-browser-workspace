export interface Product {
  id: string;
  name: string;
  price: number;
  oldPrice?: number;
  onSale?: boolean;
  emoji: string;
}

export const products: Product[] = [
  { id: 'p-001', name: 'Aurora Desk Lamp', price: 49.0, emoji: '💡' },
  { id: 'p-002', name: 'Meridian Backpack', price: 89.0, oldPrice: 119.0, onSale: true, emoji: '🎒' },
  { id: 'p-003', name: 'Cirrus Mug', price: 12.5, emoji: '🍵' },
  { id: 'p-004', name: 'Zephyr Keyboard', price: 129.0, oldPrice: 149.0, onSale: true, emoji: '⌨️' },
  { id: 'p-005', name: 'Solstice Notebook', price: 7.9, emoji: '📓' },
  { id: 'p-006', name: 'Vector Pen Set', price: 23.0, emoji: '🖊️' },
  { id: 'p-007', name: 'Halo Water Bottle', price: 18.0, emoji: '🧴' },
  { id: 'p-008', name: 'Quartz Desk Clock', price: 35.0, oldPrice: 45.0, onSale: true, emoji: '⏰' },
];
