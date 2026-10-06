// 阿里云短信(lib/server/sms.ts):POP 编码、RPC 签名(和阿里云文档里的示例、独立实现算出的结果对比)、
// 对本地假服务的发送成功与各种失败(Code 不是 OK、HTTP 错误、不是 JSON、超时、连不上),以及错误信息里不带 Secret 和完整手机号。
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SmsConfig } from "../lib/server/env.ts";
import { SmsError, canonicalQuery, percentEncode, rpcSignature, rpcTimestamp, sendLoginSms, sendSmsParams, signedSendSmsUrl } from "../lib/server/sms.ts";

const SECRET = "test/Secret+=~";
const PHONE = "+8613812345678";

/** 独立实现的 RFC 3986 编码:按 UTF-8 字节逐个判断,只有 A–Z a–z 0–9 - _ . ~ 原样保留。 */
function rfc3986(s: string): string {
  return Array.from(new TextEncoder().encode(s), (b) => {
    const c = String.fromCharCode(b);
    return /[A-Za-z0-9\-_.~]/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");
}

/** 独立实现的签名校验(假服务用):按收到的参数重新算一遍。 */
function expectedSignature(params: URLSearchParams, secret: string): string {
  const pairs = [...params.entries()].filter(([k]) => k !== "Signature");
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonical = pairs.map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`).join("&");
  const stringToSign = ["GET", rfc3986("/"), rfc3986(canonical)].join("&");
  return createHmac("sha1", `${secret}&`).update(stringToSign).digest("base64");
}

describe("POP 编码", () => {
  it("只保留 A–Z a–z 0–9 - _ . ~;空格是 %20,* 是 %2A,! ' ( ) 也要编码,中文按 UTF-8", () => {
    expect(percentEncode("a b*c~d!e'f(g)h+/=:中")).toBe("a%20b%2Ac~d%21e%27f%28g%29h%2B%2F%3D%3A%E4%B8%AD");
    for (const s of ["FDE训练场(测试)", `{"code":"042137"}`, "n0nce ~!'()*+/=", "2026-10-05T08:30:00Z"]) expect(percentEncode(s)).toBe(rfc3986(s));
  });

  it("时间戳是 UTC 的 YYYY-MM-DDTHH:mm:ssZ,不带毫秒", () => {
    expect(rpcTimestamp(new Date("2026-10-05T08:30:00.123Z"))).toBe("2026-10-05T08:30:00Z");
    expect(rpcTimestamp(new Date("2026-10-05T16:30:00+08:00"))).toBe("2026-10-05T08:30:00Z");
  });
});

describe("RPC 签名(HMAC-SHA1,签名版本 1.0)", () => {
  it("阿里云 ECS 文档的 DescribeRegions 示例", () => {
    const params = {
      Timestamp: "2016-02-23T12:46:24Z",
      Format: "XML",
      AccessKeyId: "testid",
      Action: "DescribeRegions",
      SignatureMethod: "HMAC-SHA1",
      SignatureNonce: "3ee8c1b8-83d3-44af-a94f-4e0ad82fd6cf",
      Version: "2014-05-26",
      SignatureVersion: "1.0",
    };
    expect(canonicalQuery(params)).toBe(
      "AccessKeyId=testid&Action=DescribeRegions&Format=XML&SignatureMethod=HMAC-SHA1&SignatureNonce=3ee8c1b8-83d3-44af-a94f-4e0ad82fd6cf&SignatureVersion=1.0&Timestamp=2016-02-23T12%3A46%3A24Z&Version=2014-05-26",
    );
    expect(rpcSignature(params, "testsecret")).toBe("OLeaidS1JvxuMvnyHOwuJ+uX5qY=");
  });

  it("阿里云短信文档的 SendSms 示例(中文签名名称)", () => {
    const params = {
      AccessKeyId: "testId",
      Action: "SendSms",
      Format: "XML",
      OutId: "123",
      PhoneNumbers: "15300000001",
      RegionId: "cn-hangzhou",
      SignName: "阿里云短信测试专用",
      SignatureMethod: "HMAC-SHA1",
      SignatureNonce: "45e25e9b-0a6f-4070-8c85-2956eda1b466",
      SignatureVersion: "1.0",
      TemplateCode: "SMS_71390007",
      TemplateParam: '{"customer":"test"}',
      Timestamp: "2017-07-12T02:42:19Z",
      Version: "2017-05-25",
    };
    expect(rpcSignature(params, "testSecret")).toBe("zJDF+Lrzhj/ThnlvIToysFRq6t4=");
  });

  it("本项目的登录短信参数:固定时间戳和 nonce,和 Python(urllib.parse.quote + hmac)算出的结果一致", () => {
    // 期望值由下面的独立实现算出(python3):
    //   quote(s, safe='~') 编码;canonical 按键排序;StringToSign = 'GET&%2F&' + quote(canonical, safe='~');
    //   base64(hmac.new(b'test/Secret+=~&', StringToSign, sha1))
    const params = sendSmsParams({ accessKeyId: "LTAI-test-id", signName: "FDE训练场(测试)", templateCode: "SMS_123456789" }, PHONE, "042137", {
      now: new Date("2026-10-05T08:30:00.000Z"),
      nonce: "n0nce ~!'()*+/=",
    });
    expect(params).toEqual({
      AccessKeyId: "LTAI-test-id",
      Action: "SendSms",
      Format: "JSON",
      PhoneNumbers: "13812345678",
      RegionId: "cn-hangzhou",
      SignName: "FDE训练场(测试)",
      SignatureMethod: "HMAC-SHA1",
      SignatureNonce: "n0nce ~!'()*+/=",
      SignatureVersion: "1.0",
      TemplateCode: "SMS_123456789",
      TemplateParam: '{"code":"042137"}',
      Timestamp: "2026-10-05T08:30:00Z",
      Version: "2017-05-25",
    });
    expect(canonicalQuery(params)).toBe(
      "AccessKeyId=LTAI-test-id&Action=SendSms&Format=JSON&PhoneNumbers=13812345678&RegionId=cn-hangzhou&SignName=FDE%E8%AE%AD%E7%BB%83%E5%9C%BA%28%E6%B5%8B%E8%AF%95%29&SignatureMethod=HMAC-SHA1&SignatureNonce=n0nce%20~%21%27%28%29%2A%2B%2F%3D&SignatureVersion=1.0&TemplateCode=SMS_123456789&TemplateParam=%7B%22code%22%3A%22042137%22%7D&Timestamp=2026-10-05T08%3A30%3A00Z&Version=2017-05-25",
    );
    expect(rpcSignature(params, SECRET)).toBe("lB6sYCt/Be//P/7Kwg/BdeJVOaY=");
  });

  it("请求地址:endpoint 去掉末尾斜杠,Signature 编码后放在最前面,其余是规范化请求字符串", () => {
    const cfg: SmsConfig = { accessKeyId: "LTAI-test-id", accessKeySecret: SECRET, signName: "FDE训练场(测试)", templateCode: "SMS_123456789", endpoint: "https://dysmsapi.aliyuncs.com/" };
    const url = signedSendSmsUrl(cfg, PHONE, "042137", { now: new Date("2026-10-05T08:30:00Z"), nonce: "n0nce ~!'()*+/=" });
    expect(url.startsWith("https://dysmsapi.aliyuncs.com/?Signature=lB6sYCt%2FBe%2F%2FP%2F7Kwg%2FBdeJVOaY%3D&AccessKeyId=LTAI-test-id&Action=SendSms&")).toBe(true);
    const q = new URL(url).searchParams;
    expect(q.get("Signature")).toBe("lB6sYCt/Be//P/7Kwg/BdeJVOaY=");
    expect(expectedSignature(q, SECRET)).toBe(q.get("Signature"));
    expect(url).not.toContain(SECRET);
    expect(url).not.toContain(encodeURIComponent(SECRET));
  });

  it("不传 nonce 时每次都不一样", () => {
    const cfg = { accessKeyId: "id", signName: "s", templateCode: "t" };
    expect(sendSmsParams(cfg, PHONE, "1").SignatureNonce).not.toBe(sendSmsParams(cfg, PHONE, "1").SignatureNonce);
  });
});

// ---------------------------------------------------------------- 对本地假服务发送

type Reply = { status: number; body: string } | "hang";
let server: Server;
let endpoint = "";
let reply: Reply = { status: 200, body: "" };
let received: URLSearchParams[] = [];

const ok = (extra: Record<string, unknown> = {}) => ({ status: 200, body: JSON.stringify({ Message: "OK", RequestId: "REQ-1", BizId: "900619746936498440^0", Code: "OK", ...extra }) });

function cfg(): SmsConfig {
  return { accessKeyId: "LTAI-test-id", accessKeySecret: SECRET, signName: "FDE训练场", templateCode: "SMS_123456789", endpoint };
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://fake");
    received.push(url.searchParams);
    if (reply === "hang") return; // 不响应,等客户端超时
    res.writeHead(reply.status, { "content-type": reply.body.startsWith("{") ? "application/json" : "text/html" });
    res.end(reply.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  reply = ok();
  received = [];
});

/** 抛出的 SmsError(用来检查 code 和 message)。 */
async function failure(p: Promise<unknown>): Promise<SmsError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(SmsError);
  return e as SmsError;
}

describe("sendLoginSms", () => {
  it("成功:GET 到 endpoint 根路径,参数齐全、签名能被独立实现验证,返回 BizId", async () => {
    const bizId = await sendLoginSms(cfg(), PHONE, "135790");
    expect(bizId).toBe("900619746936498440^0");
    expect(received).toHaveLength(1);
    const q = received[0]!;
    expect(Object.fromEntries([...q.entries()].filter(([k]) => !["Signature", "SignatureNonce", "Timestamp"].includes(k)))).toEqual({
      AccessKeyId: "LTAI-test-id",
      Action: "SendSms",
      Format: "JSON",
      PhoneNumbers: "13812345678",
      RegionId: "cn-hangzhou",
      SignName: "FDE训练场",
      SignatureMethod: "HMAC-SHA1",
      SignatureVersion: "1.0",
      TemplateCode: "SMS_123456789",
      TemplateParam: '{"code":"135790"}',
      Version: "2017-05-25",
    });
    expect(q.get("Timestamp")).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(q.get("SignatureNonce")).toBeTruthy();
    expect(q.get("Signature")).toBe(expectedSignature(q, SECRET));
    expect(expectedSignature(q, "wrong-secret")).not.toBe(q.get("Signature"));
  });

  it("Code 不是 OK → 抛错,信息里有 Code 和 Message", async () => {
    reply = { status: 200, body: JSON.stringify({ Code: "isv.BUSINESS_LIMIT_CONTROL", Message: "触发小时级流控Permits:5", RequestId: "REQ-2" }) };
    const e = await failure(sendLoginSms(cfg(), PHONE, "135790"));
    expect(e.code).toBe("isv.BUSINESS_LIMIT_CONTROL");
    expect(e.message).toContain("isv.BUSINESS_LIMIT_CONTROL");
    expect(e.message).toContain("触发小时级流控Permits:5");
    expect(e.message).toContain("REQ-2");
  });

  it("HTTP 错误(签名不对):信息里不带 Secret 和完整手机号(阿里云会把收到的请求原样带回来)", async () => {
    reply = {
      status: 400,
      body: JSON.stringify({
        Code: "SignatureDoesNotMatch",
        Message: `Specified signature is not matched with our calculation. server string to sign is:GET&%2F&PhoneNumbers%3D13812345678 secret=${SECRET}`,
      }),
    };
    const e = await failure(sendLoginSms(cfg(), PHONE, "135790"));
    expect(e.code).toBe("SignatureDoesNotMatch");
    expect(e.message).toContain("SignatureDoesNotMatch");
    expect(e.message).toContain("138****5678");
    expect(e.message).not.toContain("13812345678");
    expect(e.message).not.toContain(SECRET);
  });

  it("响应不是 JSON(网关错误)→ HTTP_<状态码>", async () => {
    reply = { status: 502, body: "<html>Bad Gateway</html>" };
    const e = await failure(sendLoginSms(cfg(), PHONE, "135790"));
    expect(e.code).toBe("HTTP_502");
    expect(e.message).toContain("HTTP 502");
  });

  it("没有响应 → 超时(正式是 10 秒,这里缩短)", async () => {
    reply = "hang";
    const started = Date.now();
    const e = await failure(sendLoginSms(cfg(), PHONE, "135790", { timeoutMs: 300 }));
    expect(e.code).toBe("TIMEOUT");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("连不上 → NETWORK,信息里不带请求地址", async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const e = await failure(sendLoginSms({ ...cfg(), endpoint: `http://127.0.0.1:${port}` }, PHONE, "135790"));
    expect(e.code).toBe("NETWORK");
    expect(e.message).not.toContain("Signature");
    expect(e.message).not.toContain("13812345678");
  });
});
