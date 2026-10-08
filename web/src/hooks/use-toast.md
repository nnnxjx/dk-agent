# `use-toast` Hook 使用说明

## 1. 文件作用

`use-toast.ts` 提供了一个轻量的 Toast（短暂提示消息）状态管理器，负责：

- 创建一条 Toast，并返回它的 `id`、更新方法和关闭方法；
- 在内存中保存当前 Toast 列表；
- 将 Toast 的状态同步给 React 组件；
- 支持单独关闭、全部关闭、更新和延迟移除；
- 与 `src/components/ui/toaster.tsx` 以及 `src/components/ui/toast.tsx` 配合完成渲染。

这个文件本身不负责绘制 UI。它只管理数据和状态，真正的 Toast 结构、样式、关闭按钮和显示位置由 `Toaster`、`Toast` 等组件负责。

## 2. 基本使用方式

### 2.1 在应用根部挂载 `Toaster`

项目已经提供了 `src/components/ui/toaster.tsx`，它会订阅 `useToast` 的状态并渲染所有 Toast。应用需要在根布局或根组件中挂载一次：

```tsx
import { Toaster } from "@/components/ui/toaster"

export function AppLayout() {
  return (
    <>
      {/* 页面路由或其他页面内容 */}
      <Toaster />
    </>
  )
}
```

如果没有挂载 `Toaster`，调用 `toast()` 仍然会更新内存状态，但页面上没有组件读取并渲染这些状态，因此用户看不到提示。

### 2.2 在组件中调用 `toast`

```tsx
import { toast } from "@/hooks/use-toast"

export function SaveButton() {
  function handleSave() {
    toast({
      title: "保存成功",
      description: "配置已经保存。",
    })
  }

  return <button onClick={handleSave}>保存</button>
}
```

`toast()` 返回一个控制对象，可以在后续代码中更新或关闭这条 Toast：

```tsx
import { toast } from "@/hooks/use-toast"

export async function submitForm() {
  const currentToast = toast({
    title: "正在提交",
    description: "请稍候。",
  })

  try {
    await requestSubmit()

    currentToast.update({
      id: currentToast.id,
      title: "提交成功",
      description: "数据已提交。",
      open: true,
    })
  } catch {
    currentToast.update({
      id: currentToast.id,
      title: "提交失败",
      description: "请稍后重试。",
      variant: "destructive",
      open: true,
    })
  }
}
```

在 React 组件中，也可以使用 Hook 返回的 `toast` 和 `dismiss`：

```tsx
import { useToast } from "@/hooks/use-toast"

export function ImportButton() {
  const { toast, dismiss } = useToast()

  function handleImport() {
    const currentToast = toast({
      title: "开始导入",
      description: "文件正在处理中。",
    })

    // 需要主动关闭时：
    dismiss(currentToast.id)
  }

  return <button onClick={handleImport}>导入</button>
}
```

## 3. 支持的 Toast 参数

`toast` 的参数类型是：

```ts
type Toast = Omit<ToasterToast, "id">

type ToasterToast = ToastProps & {
  id: string
  title?: React.ReactNode
  description?: React.ReactNode
  action?: ToastActionElement
}
```

因此，常用参数包括：

| 参数 | 说明 |
| --- | --- |
| `title` | Toast 标题，支持字符串、React 节点等。 |
| `description` | Toast 描述内容，支持字符串、React 节点等。 |
| `variant` | 当前 UI 组件支持 `default` 和 `destructive` 两种样式。 |
| `action` | 操作按钮节点，通常使用 `ToastAction` 创建。 |
| `open` | 是否显示 Toast。新建 Toast 时 Hook 会自动设置为 `true`。 |
| 其他 `ToastProps` | 由 Radix Toast 组件提供的属性，也可以传入。 |

带操作按钮的示例：

```tsx
import { toast } from "@/hooks/use-toast"
import { ToastAction } from "@/components/ui/toast"

export function DeleteButton() {
  function handleDelete() {
    toast({
      variant: "destructive",
      title: "删除失败",
      description: "无法删除这条记录。",
      action: (
        <ToastAction altText="重试" onClick={() => console.log("retry")}>
          重试
        </ToastAction>
      ),
    })
  }

  return <button onClick={handleDelete}>删除</button>
}
```

## 4. 内部实现逻辑

### 4.1 Toast 数据结构

Hook 将每条 Toast 表示为一个带 `id` 的对象。`title`、`description` 和 `action` 是内容，`open` 决定它是否处于打开状态，其他属性会继续传递给底层 Radix Toast：

```ts
type ToasterToast = ToastProps & {
  id: string
  title?: React.ReactNode
  description?: React.ReactNode
  action?: ToastActionElement
}
```

### 4.2 ID 生成

模块级变量 `count` 用来生成递增字符串 ID：

```ts
let count = 0

function genId() {
  count = (count + 1) % Number.MAX_SAFE_INTEGER
  return count.toString()
}
```

ID 不依赖组件实例，因此直接调用导出的 `toast()` 也可以正常工作。

### 4.3 模块级内存状态和订阅者

状态保存在模块级变量中，而不是某个具体组件的 `useState` 中：

```ts
const listeners: Array<(state: State) => void> = []
let memoryState: State = { toasts: [] }

function dispatch(action: Action) {
  memoryState = reducer(memoryState, action)
  listeners.forEach((listener) => {
    listener(memoryState)
  })
}
```

这样设计的好处是：

1. 可以在 React 组件外直接调用 `toast()`；
2. `Toaster` 挂载后可以读取已经存在的 Toast；
3. 所有订阅了状态的组件都能收到最新状态。

`useToast()` 首次执行时读取 `memoryState`，然后把自己的 `setState` 加入 `listeners`。组件卸载时会移除监听器，避免继续更新已经卸载的组件。

对应代码如下：

```ts
function useToast() {
  const [state, setState] = React.useState<State>(memoryState)

  React.useEffect(() => {
    listeners.push(setState)

    return () => {
      const index = listeners.indexOf(setState)
      if (index > -1) {
        listeners.splice(index, 1)
      }
    }
  }, [state])

  return {
    ...state,
    toast,
    dismiss: (toastId?: string) =>
      dispatch({ type: "DISMISS_TOAST", toastId }),
  }
}
```

### 4.4 `reducer` 如何处理动作

所有状态变化都通过 `dispatch` 交给 `reducer` 处理。当前支持四种动作：

```ts
const actionTypes = {
  ADD_TOAST: "ADD_TOAST",
  UPDATE_TOAST: "UPDATE_TOAST",
  DISMISS_TOAST: "DISMISS_TOAST",
  REMOVE_TOAST: "REMOVE_TOAST",
} as const
```

- `ADD_TOAST`：把新 Toast 放到列表最前面；
- `UPDATE_TOAST`：按 `id` 合并更新 Toast 属性；
- `DISMISS_TOAST`：将 Toast 的 `open` 设置为 `false`；
- `REMOVE_TOAST`：从状态列表中真正删除 Toast。

新增 Toast 的核心逻辑如下：

```ts
case "ADD_TOAST":
  return {
    ...state,
    toasts: [action.toast, ...state.toasts].slice(0, TOAST_LIMIT),
  }
```

当前 `TOAST_LIMIT` 是 `1`，因此状态中最多保留一条 Toast。连续调用 `toast()` 时，新的 Toast 会排在前面，并把旧 Toast 从状态列表中截掉。

更新逻辑使用浅合并：

```ts
case "UPDATE_TOAST":
  return {
    ...state,
    toasts: state.toasts.map((t) =>
      t.id === action.toast.id ? { ...t, ...action.toast } : t
    ),
  }
```

### 4.5 关闭和移除的区别

关闭 Toast 分成两个阶段：

1. `DISMISS_TOAST`：立即把 `open` 设置为 `false`，让 Radix Toast 播放关闭动画；
2. `REMOVE_TOAST`：等待一段时间后从状态中删除，避免动画还没完成就移除 DOM。

延迟时间由下面的常量控制：

```ts
const TOAST_REMOVE_DELAY = 1000000
```

当前值是 `1,000,000` 毫秒，大约为 16 分 40 秒。关闭后，Toast 会在该延迟结束后从内存状态中移除。

待移除的定时器保存在 `toastTimeouts` 中，同一个 Toast 不会重复创建定时器：

```ts
const toastTimeouts = new Map<string, ReturnType<typeof setTimeout>>()
```

调用 `dismiss()` 时：

- 传入 `toastId`：只关闭指定 Toast；
- 不传 `toastId`：关闭当前列表中的所有 Toast。

```ts
const { dismiss } = useToast()

dismiss("1") // 关闭指定 Toast
dismiss()    // 关闭全部 Toast
```

### 4.6 `toast()` 返回值

`toast()` 的完整核心逻辑如下：

```ts
function toast({ ...props }: Toast) {
  const id = genId()

  const update = (props: ToasterToast) =>
    dispatch({
      type: "UPDATE_TOAST",
      toast: { ...props, id },
    })

  const dismiss = () =>
    dispatch({ type: "DISMISS_TOAST", toastId: id })

  dispatch({
    type: "ADD_TOAST",
    toast: {
      ...props,
      id,
      open: true,
      onOpenChange: (open) => {
        if (!open) dismiss()
      },
    },
  })

  return {
    id,
    dismiss,
    update,
  }
}
```

返回值可以理解为：

```ts
{
  id: string
  dismiss: () => void
  update: (props: ToasterToast) => void
}
```

其中：

- `id`：当前 Toast 的唯一标识；
- `dismiss()`：关闭当前 Toast；
- `update(props)`：用新的属性更新当前 Toast。

`onOpenChange` 会监听 Radix Toast 的打开状态。当用户点击关闭按钮、滑动关闭或 Radix 自己将 Toast 设置为关闭时，会自动调用当前 Toast 的 `dismiss()`。

## 5. `Toaster` 是如何消费状态的

项目中的 `Toaster` 会从 Hook 中取出 `toasts`，再把每一项映射成 UI：

```tsx
export function Toaster() {
  const { toasts } = useToast()

  return (
    <ToastProvider>
      {toasts.map(function ({ id, title, description, action, ...props }) {
        return (
          <Toast key={id} {...props}>
            <div className="grid gap-1">
              {title && <ToastTitle>{title}</ToastTitle>}
              {description && (
                <ToastDescription>{description}</ToastDescription>
              )}
            </div>
            {action}
            <ToastClose />
          </Toast>
        )
      })}
      <ToastViewport />
    </ToastProvider>
  )
}
```

这里的调用链是：

```text
业务组件调用 toast()
        ↓
dispatch(action)
        ↓
reducer 更新 memoryState
        ↓
通知 listeners
        ↓
Toaster 的 useToast() 更新
        ↓
Toaster 渲染 Toast
```

## 6. 使用时的注意事项

### 6.1 只挂载一个 `Toaster`

通常整个应用只需要一个全局 `Toaster`。如果同一页面挂载多个 `Toaster`，它们都会订阅同一个内存状态，可能导致同一条消息渲染多次。

### 6.2 当前最多显示一条 Toast

`TOAST_LIMIT = 1` 限制的是状态列表长度。如果业务需要同时显示多条提示，需要调整这个常量，并确认 UI 和交互是否适合多条消息。

### 6.3 `update` 需要传入 `id`

`update` 内部会强制使用创建时的 ID 覆盖传入对象的 ID，但 TypeScript 类型仍要求传入完整的 `ToasterToast`，因此调用时建议保留当前 ID：

```ts
const currentToast = toast({ title: "处理中" })

currentToast.update({
  id: currentToast.id,
  title: "处理完成",
  open: true,
})
```

### 6.4 `toast` 可以在组件外调用

因为状态和 `dispatch` 都是模块级的，所以以下场景可以直接导入 `toast` 使用：

- API 请求工具；
- 表单提交函数；
- 事件处理器；
- 非 React 工具函数。

但要确保应用生命周期内已经挂载了 `Toaster`。

### 6.5 这是客户端 Hook

文件顶部包含：

```ts
"use client"
```

因此它依赖浏览器端的 React 状态、事件和定时器。使用它的组件也应运行在客户端环境中。

## 7. 最小完整示例

```tsx
// App.tsx
import { Toaster } from "@/components/ui/toaster"
import { toast } from "@/hooks/use-toast"

function App() {
  return (
    <>
      <button
        onClick={() =>
          toast({
            title: "操作成功",
            description: "这是一条 Toast 提示。",
          })
        }
      >
        显示提示
      </button>
      <Toaster />
    </>
  )
}

export default App
```

点击按钮后，`toast()` 创建消息，`Toaster` 从共享状态中读取消息并渲染；点击关闭按钮时，Toast 先关闭动画，之后再根据 `TOAST_REMOVE_DELAY` 从状态中移除。
