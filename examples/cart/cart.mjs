export function total(items) {
  return items.map(item => item.price * item.quantity).reduce((sum, price) => sum + price);
}
