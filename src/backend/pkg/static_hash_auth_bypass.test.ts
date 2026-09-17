import { strict as assert } from "node:assert"
import test from "node:test"

import {
  staticHash,
  saltedHash,
  twoStepHash,
  generateSalt,
  isHex64,
  setUserPassword,
  verifyUserPassword,
  verifyUserStaticHashValue,
} from "./password"

/**
 * 口令校验的输入语义契约。
 *
 * 本项目存在两种「提交值」形态，必须严格区分，混用即产生认证旁路：
 *
 *   1. **明文**：`/login`（普通登录）、`/me/update`（改密校验）、WebDAV Basic Auth。
 *      校验 = `saltedHash(staticHash(plain), salt)`，即
 *      `store/password.ts verifyUserPassword(plain, user)`。
 *
 *   2. **静态哈希**：Go 前端 `/login/hash` 提交的是 `staticHash(pwd)`。
 *      校验 = `saltedHash(staticHashValue, salt)`，**缺少 staticHash 这一层**，
 *      对应 `store/auth.ts verifyUserStaticHash(user, inputStatic)`
 *      与 `pkg/password.ts verifyUserStaticHashValue(inputStatic, user)`。
 *
 * 关键安全约束：**明文校验函数绝不能被喂入静态哈希**。
 * 若 `verifyUserPassword` 把「64 位 hex 的输入」当作已静态哈希而跳过
 * `staticHash()`，则 `staticHash(pwd)`（网页端每次登录都会产生、且会出现在
 * 浏览器内存与网络面板中的值）就成了可直接使用的口令等价物，属于
 * 「哈希当密码」旁路。本文件用 test 1 锁死这一点。
 */

test("明文校验必须拒绝静态哈希输入（禁止「哈希当口令」旁路）", async () => {
  const salt = generateSalt()
  const pwd = "operator-secret-42"
  const user = { password: await twoStepHash(pwd, salt), salt }

  // 明文：正常通过
  assert.equal(await verifyUserPassword(pwd, user), true, "明文必须能通过")
  assert.equal(await verifyUserPassword("wrong", user), false, "错误明文必须失败")

  // 静态哈希：明文校验函数必须视为「另一个明文」而拒绝
  const S = await staticHash(pwd)
  assert.equal(
    await verifyUserPassword(S, user),
    false,
    "staticHash(pwd) 不是明文，不得在明文校验路径通过",
  )

  // 存储哈希本身：同样不得通过
  assert.equal(
    await verifyUserPassword(user.password, user),
    false,
    "存储哈希不得直接通过明文校验",
  )
})

test("静态哈希校验只认 staticHash 形态的值", async () => {
  const salt = generateSalt()
  const pwd = "operator-secret-42"
  const user = { password: await twoStepHash(pwd, salt), salt }
  const S = await staticHash(pwd)

  // /login/hash 语义：输入就是 staticHash(pwd) → 通过
  assert.equal(
    await verifyUserStaticHashValue(S, user),
    true,
    "staticHash(pwd) 必须能通过静态哈希校验（/login/hash 依赖）",
  )
  // 明文不是静态哈希形态 → 拒绝（调用方应走 verifyUserPassword）
  assert.equal(await verifyUserStaticHashValue(pwd, user), false, "明文不得混入该路径")
  // 存储哈希不得自证通过
  assert.equal(
    await verifyUserStaticHashValue(user.password, user),
    false,
    "存储哈希不得通过静态哈希校验",
  )
})

test("历史单层（无盐）数据保持兼容", async () => {
  const pwd = "legacy-secret"
  const stored = await staticHash(pwd)
  const user = { password: stored }

  assert.equal(await verifyUserPassword(pwd, user), true, "单层旧数据必须能登录")
  assert.equal(
    await verifyUserStaticHashValue(stored, user),
    true,
    "单层旧数据在 /login/hash 路径也必须能登录",
  )
  assert.equal(await verifyUserPassword("bad", user), false)
})

test("setUserPassword 生成规范双层结构且可验证", async () => {
  const user: any = {}
  const pwd = "another-secret"
  await setUserPassword(user, pwd)

  assert.ok(user.salt, "必须生成 per-user 盐")
  assert.equal(user.salt.length, 16)
  assert.ok(isHex64(user.password))

  const expected = await saltedHash(await staticHash(pwd), user.salt)
  assert.equal(
    user.password,
    expected,
    "存储值必须等于 saltedHash(staticHash(pwd), salt)",
  )
  assert.equal(await verifyUserPassword(pwd, user), true)
  assert.equal(await verifyUserPassword("bad", user), false)
  assert.equal(await verifyUserStaticHashValue(await staticHash(pwd), user), true)
})
