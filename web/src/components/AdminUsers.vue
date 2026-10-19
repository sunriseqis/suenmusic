<script setup lang="ts">
/**
 * 管理员：账号列表 / 新建 / 重置口令 / 角色 / 注册开关。
 *
 * 只出现在设置页的「高级」里，且仅 admin 可见。
 */
import { onMounted, ref } from 'vue';
import NeuButton from '@/components/neu/NeuButton.vue';
import NeuInput from '@/components/neu/NeuInput.vue';
import NeuSwitch from '@/components/neu/NeuSwitch.vue';
import { http, ApiError } from '@/api/client.ts';
import { useUiStore } from '@/stores/ui.ts';
import type { PublicUser } from '@/api/types.ts';

const ui = useUiStore();
const users = ref<PublicUser[]>([]);
const allowRegistration = ref(false);
const minLength = ref(8);
const username = ref('');
const password = ref('');
const busy = ref(false);

async function load(): Promise<void> {
  try {
    const [u, s] = await Promise.all([
      http.get<{ users: PublicUser[] }>('/api/admin/users'),
      http.get<{ allowRegistration: boolean; passwordMinLength: number }>('/api/admin/settings'),
    ]);
    users.value = u.users;
    allowRegistration.value = s.allowRegistration;
    minLength.value = s.passwordMinLength;
  } catch (e) {
    ui.err(e instanceof ApiError ? e.message : '读取账号失败');
  }
}

async function add(): Promise<void> {
  if (!username.value.trim() || !password.value) return;
  busy.value = true;
  try {
    await http.post('/api/admin/users', {
      username: username.value.trim(),
      password: password.value,
    });
    username.value = '';
    password.value = '';
    ui.ok('已创建');
    await load();
  } catch (e) {
    ui.err(e instanceof ApiError ? e.message : '创建失败');
  } finally {
    busy.value = false;
  }
}

async function setRole(u: PublicUser, role: 'admin' | 'member'): Promise<void> {
  try {
    await http.patch(`/api/admin/users/${u.id}`, { role });
    await load();
  } catch (e) {
    ui.err(e instanceof ApiError ? e.message : '修改失败');
  }
}

async function resetPassword(u: PublicUser): Promise<void> {
  const next = window.prompt(`为 ${u.username} 设置新口令`);
  if (!next) return;
  try {
    await http.patch(`/api/admin/users/${u.id}`, { password: next });
    ui.ok('口令已重置');
  } catch (e) {
    ui.err(e instanceof ApiError ? e.message : '重置失败');
  }
}

async function saveMinLength(): Promise<void> {
  try {
    const res = await http.patch<{ passwordMinLength: number }>('/api/admin/settings', {
      passwordMinLength: minLength.value,
    });
    minLength.value = res.passwordMinLength;
    ui.ok('口令策略已更新');
  } catch (e) {
    ui.err(e instanceof ApiError ? e.message : '保存失败');
  }
}

async function removeUser(u: PublicUser): Promise<void> {
  if (!window.confirm(`删除账号 ${u.username}？收藏与历史会一并删除。`)) return;
  try {
    await http.delete(`/api/admin/users/${u.id}`);
    ui.ok('已删除');
    await load();
  } catch (e) {
    ui.err(e instanceof ApiError ? e.message : '删除失败');
  }
}

async function toggleRegistration(v: boolean): Promise<void> {
  allowRegistration.value = v;
  try {
    await http.patch('/api/admin/settings', { allowRegistration: v });
  } catch (e) {
    allowRegistration.value = !v;
    ui.err(e instanceof ApiError ? e.message : '修改失败');
  }
}

onMounted(load);
</script>

<template>
  <div class="admin">
    <div class="rows">
      <div v-for="u in users" :key="u.id" class="row">
        <span class="name">{{ u.username }}</span>
        <span class="role">{{ u.role === 'admin' ? '管理员' : '成员' }}</span>
        <button type="button" class="link" @click="resetPassword(u)">重置口令</button>
        <button
          type="button"
          class="link"
          @click="setRole(u, u.role === 'admin' ? 'member' : 'admin')"
        >
          {{ u.role === 'admin' ? '降为成员' : '设为管理员' }}
        </button>
        <button type="button" class="link danger" @click="removeUser(u)">删除</button>
      </div>
    </div>

    <div class="add">
      <NeuInput v-model="username" placeholder="新成员用户名" />
      <NeuInput v-model="password" type="password" placeholder="初始口令" />
      <NeuButton :loading="busy" @click="add">创建</NeuButton>
    </div>

    <div class="row">
      <span class="name">开放注册</span>
      <NeuSwitch :model-value="allowRegistration" @update:model-value="toggleRegistration" />
    </div>

    <div class="row">
      <span class="name">口令最短长度</span>
      <input v-model.number="minLength" class="num" type="number" min="8" max="64" />
      <button type="button" class="link" @click="saveMinLength">保存</button>
    </div>
  </div>
</template>

<style scoped>
.admin {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.rows {
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  overflow: hidden;
}
.row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  min-height: 44px;
  padding: 0 var(--sp-4);
}
.rows .row + .row {
  border-top: 1px solid var(--line);
}
.name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--fs-sm);
  overflow: hidden;
  text-overflow: ellipsis;
}
.role {
  font-size: var(--fs-xs);
  color: var(--t2);
}
.link {
  border: 0;
  background: transparent;
  color: var(--accent-text);
  font-size: var(--fs-xs);
  cursor: pointer;
}
.add {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: var(--sp-2);
  align-items: center;
}
</style>
