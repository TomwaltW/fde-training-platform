// 商品、免费场景与预售开关(第三轮)。
// T0 占位:F3(预售与兑换码)实现 config/products.yaml 的读取后替换本文件;在那之前所有场景免费、预售页不开。

/** 预售页是否开放(有上架商品)。 */
export function presaleOpen(): boolean {
  return false;
}

/** 场景的访问方式:free 人人可玩,paid 需要兑换。 */
export function scenarioAccess(_scenarioId: string): "free" | "paid" {
  return "free";
}
