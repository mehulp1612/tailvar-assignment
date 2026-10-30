const currency = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
});

export const formatMoney = (minor: number) => currency.format(minor / 100);
