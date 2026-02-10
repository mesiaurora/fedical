import { useCallback, useEffect, useMemo, useState } from "react";

const dayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const getWeekStart = (baseDate: Date) => {
  const date = new Date(baseDate);
  const dayIndex = (date.getDay() + 6) % 7;
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - dayIndex);
  return date;
};

const formatDate = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

type PlannedPost = {
  id: string;
  instance: string;
  scheduledAt: string;
  text: string;
  visibility: "public" | "unlisted" | "private" | "direct";
  status: "draft" | "scheduled" | "sent" | "canceled";
};

type AccountIdentity = {
  username: string;
  acct: string;
  displayName: string;
  avatar?: string;
};

export default function App() {
  const [weekStartDate, setWeekStartDate] = useState<Date>(() => getWeekStart(new Date()));
  const [instance, setInstance] = useState("https://mastodon.social");
  const [posts, setPosts] = useState<PlannedPost[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState<AccountIdentity | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [selectedDay, setSelectedDay] = useState<Date>(() => getWeekStart(new Date()));
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [formScheduledAt, setFormScheduledAt] = useState("");
  const [formText, setFormText] = useState("");
  const [formVisibility, setFormVisibility] =
    useState<PlannedPost["visibility"]>("public");
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activePost, setActivePost] = useState<PlannedPost | null>(null);
  const [editScheduledAt, setEditScheduledAt] = useState("");
  const [editText, setEditText] = useState("");
  const [editVisibility, setEditVisibility] =
    useState<PlannedPost["visibility"]>("public");
  const [editError, setEditError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const weekDates = useMemo(
    () =>
      dayLabels.map((label, index) => {
        const date = new Date(weekStartDate);
        date.setDate(weekStartDate.getDate() + index);
        return { label, date };
      }),
    [weekStartDate]
  );

  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  const today = new Date();

  const fetchPosts = useCallback(
    async (signal?: AbortSignal) => {
      setIsLoading(true);
      setError(null);
      const from = new Date(weekStartDate);
      from.setHours(0, 0, 0, 0);
      const to = new Date(from);
      to.setDate(from.getDate() + 7);

      const url =
        "/posts?instance=" +
        encodeURIComponent(instance) +
        "&from=" +
        encodeURIComponent(from.toISOString()) +
        "&to=" +
        encodeURIComponent(to.toISOString());

      try {
        const res = await fetch(url, { signal });
        if (!res.ok) {
          throw new Error(`Failed to load posts (${res.status})`);
        }
        const data = (await res.json()) as { posts?: PlannedPost[] };
        setPosts(Array.isArray(data.posts) ? data.posts : []);
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return;
        }
        setError("Could not load posts for this week.");
        setPosts([]);
      } finally {
        setIsLoading(false);
      }
    },
    [instance, weekStartDate]
  );

  useEffect(() => {
    const controller = new AbortController();
    fetchPosts(controller.signal);
    return () => controller.abort();
  }, [fetchPosts]);

  useEffect(() => {
    const controller = new AbortController();
    const fetchAccount = async () => {
      setAuthLoading(true);
      setAuthError(null);
      try {
        const res = await fetch(
          `/auth/me?instance=${encodeURIComponent(instance)}`,
          { signal: controller.signal }
        );
        if (res.status === 401) {
          setAccount(null);
          return;
        }
        if (!res.ok) {
          throw new Error(`Failed to check login (${res.status})`);
        }
        const data = (await res.json()) as { account?: AccountIdentity };
        if (data.account) {
          setAccount(data.account);
        } else {
          setAccount(null);
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return;
        }
        setAuthError("Could not check login for this instance.");
        setAccount(null);
      } finally {
        setAuthLoading(false);
      }
    };

    fetchAccount();
    return () => controller.abort();
  }, [instance]);

  const startConnect = async () => {
    if (!instance.trim()) {
      setAuthError("Instance is required.");
      return;
    }
    setIsConnecting(true);
    setAuthError(null);
    try {
      const registerRes = await fetch("/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instanceUrl: instance.trim() }),
      });
      if (!registerRes.ok) {
        const data = (await registerRes.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? "Failed to register app");
      }
      const registerData = (await registerRes.json()) as { instance: string; clientId: string };
      const authorizeRes = await fetch(
        `/auth/authorize?instance=${encodeURIComponent(registerData.instance)}&clientId=${encodeURIComponent(
          registerData.clientId
        )}`
      );
      if (!authorizeRes.ok) {
        const data = (await authorizeRes.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? "Failed to build authorize URL");
      }
      const authorizeData = (await authorizeRes.json()) as { authorizeUrl: string };

      const popup = window.open(authorizeData.authorizeUrl, "_blank", "noopener,noreferrer");
      if (!popup) {
        throw new Error("Popup blocked. Please allow popups and try again.");
      }

      setAuthLoading(true);
      const start = Date.now();
      const poll = async () => {
        try {
          const res = await fetch(`/auth/me?instance=${encodeURIComponent(instance)}`);
          if (res.ok) {
            const data = (await res.json()) as { account?: AccountIdentity };
            if (data.account) {
              setAccount(data.account);
              setAuthLoading(false);
              return true;
            }
          }
        } catch {
          // ignore and keep polling
        }
        return false;
      };

      const interval = window.setInterval(async () => {
        const done = await poll();
        if (done || Date.now() - start > 120_000) {
          window.clearInterval(interval);
          setAuthLoading(false);
        }
      }, 2000);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Failed to connect");
    } finally {
      setIsConnecting(false);
    }
  };

  const postsByDay = useMemo(() => {
    const map = new Map<string, PlannedPost[]>();
    for (const post of posts) {
      const date = new Date(post.scheduledAt);
      const key = formatDate(date);
      const list = map.get(key) ?? [];
      list.push(post);
      map.set(key, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
    }
    return map;
  }, [posts]);

  const formatTime = (iso: string) => {
    const date = new Date(iso);
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
  };

  const getDefaultScheduledAt = (day: Date) => {
    const now = new Date();
    const rounded = new Date(now);
    rounded.setSeconds(0, 0);
    const minutes = rounded.getMinutes();
    const nextQuarter = Math.ceil((minutes + 1) / 15) * 15;
    rounded.setMinutes(nextQuarter);

    const target = new Date(day);
    target.setHours(rounded.getHours(), rounded.getMinutes(), 0, 0);
    return target.toISOString().slice(0, 16);
  };

  const getLocalDateTimeValue = (iso: string) => {
    const date = new Date(iso);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  };

  const openModal = (dayOverride?: Date) => {
    const targetDay = dayOverride ?? selectedDay;
    if (dayOverride) {
      setSelectedDay(dayOverride);
    }
    setFormError(null);
    setFormText("");
    setFormVisibility("public");
    setFormScheduledAt(getDefaultScheduledAt(targetDay));
    setIsModalOpen(true);
  };

  const openEditModal = (post: PlannedPost) => {
    setActivePost(post);
    setEditError(null);
    setEditText(post.text);
    setEditVisibility(post.visibility);
    setEditScheduledAt(getLocalDateTimeValue(post.scheduledAt));
  };

  const closeEditModal = () => {
    setActivePost(null);
    setEditError(null);
    setIsEditing(false);
    setIsDeleting(false);
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setFormError(null);
  };

  const handleSubmit = useCallback(async () => {
    if (formText.trim().length === 0 || formText.length > 500) {
      return;
    }
    setIsSubmitting(true);
    setFormError(null);
    try {
      const payload = {
        instance,
        scheduledAt: new Date(formScheduledAt).toISOString(),
        text: formText.trim(),
        visibility: formVisibility,
      };
      const res = await fetch("/posts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? "Failed to create post");
      }
      closeModal();
      await fetchPosts();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to create post");
    } finally {
      setIsSubmitting(false);
    }
  }, [fetchPosts, formScheduledAt, formText, formVisibility, instance]);

  const handleUpdate = async () => {
    if (!activePost) {
      return;
    }
    if (editText.trim().length === 0) {
      setEditError("Text is required.");
      return;
    }
    if (editText.length > 500) {
      setEditError("Text must be 500 characters or less.");
      return;
    }
    if (!editScheduledAt) {
      setEditError("Scheduled time is required.");
      return;
    }
    const parsed = new Date(editScheduledAt);
    if (Number.isNaN(parsed.getTime())) {
      setEditError("Scheduled time must be a valid date.");
      return;
    }
    setIsEditing(true);
    setEditError(null);
    try {
      const payload = {
        scheduledAt: new Date(editScheduledAt).toISOString(),
        text: editText.trim(),
        visibility: editVisibility,
      };
      const res = await fetch(`/posts/${activePost.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? "Failed to update post");
      }
      closeEditModal();
      await fetchPosts();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Failed to update post");
    } finally {
      setIsEditing(false);
    }
  };

  const handleDelete = async () => {
    if (!activePost) {
      return;
    }
    const confirmed = window.confirm("Delete this post?");
    if (!confirmed) {
      return;
    }
    setIsDeleting(true);
    setEditError(null);
    try {
      const res = await fetch(`/posts/${activePost.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? "Failed to delete post");
      }
      closeEditModal();
      await fetchPosts();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Failed to delete post");
    } finally {
      setIsDeleting(false);
    }
  };

  useEffect(() => {
    if (!isModalOpen) {
      return;
    }
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeModal();
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        void handleSubmit();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [isModalOpen, handleSubmit]);

  const shiftWeek = (direction: number) => {
    setWeekStartDate((current) => {
      const next = new Date(current);
      next.setDate(current.getDate() + direction * 7);
      return next;
    });
  };

  const characterCount = formText.length;
  const isSubmitDisabled = formText.trim().length === 0 || characterCount > 500 || isSubmitting;
  const editCharacterCount = editText.length;
  const isEditDisabled = editText.trim().length === 0 || editCharacterCount > 500 || isEditing;

  return (
    <div className="min-h-screen px-6 py-10">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8">
        <header className="flex flex-col gap-6 rounded-3xl border border-slate-200 bg-white/80 p-8 shadow-[0_20px_60px_rgba(15,23,42,0.08)]">
          <div className="flex flex-wrap items-start justify-between gap-6">
            <div className="flex flex-col gap-3">
              <p className="text-sm uppercase tracking-[0.3em] text-slate-400">Fediverse Planner</p>
              <h1 className="text-4xl font-semibold text-slate-900">Fedical</h1>
              <p className="max-w-2xl text-base text-slate-500">
                Local planner for scheduled posts
              </p>
            </div>
            <div className="flex w-full max-w-md flex-col gap-3">
              <label className="flex items-center gap-3 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm text-slate-500 shadow-sm">
                <span className="text-xs uppercase tracking-[0.2em] text-slate-400">Instance</span>
                <input
                  value={instance}
                  onChange={(event) => setInstance(event.target.value)}
                  className="w-full bg-transparent text-sm text-slate-700 outline-none"
                  placeholder="https://mastodon.social"
                />
              </label>
              <div className="flex items-center justify-between gap-3 text-xs text-slate-500">
                {authLoading ? (
                  <span>Checking login...</span>
                ) : account ? (
                  <div className="flex items-center gap-2">
                    {account.avatar ? (
                      <img
                        src={account.avatar}
                        alt={account.displayName || account.acct}
                        className="h-7 w-7 rounded-full border border-slate-200 object-cover"
                      />
                    ) : (
                      <div className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-100 text-[10px] font-semibold text-slate-500">
                        @
                      </div>
                    )}
                    <span className="font-medium text-slate-700">
                      {account.displayName || `@${account.acct}`}
                    </span>
                  </div>
                ) : (
                  <button
                    onClick={startConnect}
                    disabled={isConnecting}
                    className="rounded-full border border-slate-200 px-3 py-1 text-xs font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-900 disabled:cursor-not-allowed disabled:text-slate-400"
                  >
                    {isConnecting ? "Connecting..." : "Connect"}
                  </button>
                )}
                {authError && <span className="text-rose-500">{authError}</span>}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-200 pt-4">
            <div>
              <h2 className="text-2xl font-semibold text-slate-900">
                Week of {formatDate(weekStartDate)}
              </h2>
              <p className="text-sm text-slate-500">Draft a week of thoughtful posts.</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={openModal}
                className="rounded-full border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-medium text-indigo-700 transition hover:border-indigo-300 hover:bg-indigo-100"
              >
                Add post
              </button>
              <button
                onClick={() => shiftWeek(-1)}
                className="rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
              >
                Prev week
              </button>
              <button
                onClick={() => shiftWeek(1)}
                className="rounded-full bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-slate-800"
              >
                Next week
              </button>
            </div>
          </div>
        </header>

        <section className="rounded-3xl border border-slate-200 bg-white/70 p-6 shadow-[0_16px_50px_rgba(15,23,42,0.06)]">
          {isLoading && (
            <div className="mb-4 rounded-2xl border border-indigo-100 bg-indigo-50/70 px-4 py-3 text-sm text-indigo-700">
              Loading posts for this week...
            </div>
          )}
          {error && (
            <div className="mb-4 rounded-2xl border border-rose-100 bg-rose-50/80 px-4 py-3 text-sm text-rose-700">
              {error}
            </div>
          )}
          <div className="grid grid-cols-7 gap-4 text-sm font-semibold text-slate-500">
            {weekDates.map((day) => (
              <div key={day.label} className="text-center">
                <div>{day.label}</div>
                <div className="text-xs font-medium text-slate-400">
                  {day.date.getDate()}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 grid grid-cols-7 gap-4">
            {weekDates.map((day) => {
              const dayKey = formatDate(day.date);
              const dayPosts = postsByDay.get(dayKey) ?? [];
              const isSelected = isSameDay(day.date, selectedDay);
              return (
                <div
                  key={`${day.label}-cell`}
                  onClick={() => openModal(day.date)}
                  className={`h-32 cursor-pointer rounded-2xl border border-dashed p-3 text-xs shadow-inner transition ${
                    isSameDay(day.date, today)
                      ? "border-indigo-400 bg-indigo-50/80 text-indigo-600 shadow-[0_0_0_2px_rgba(99,102,241,0.15)]"
                      : "border-slate-200 bg-white/90 text-slate-400 hover:border-slate-300 hover:bg-white"
                  } ${isSelected ? "ring-2 ring-indigo-200" : ""}`}
                >
                  {dayPosts.length === 0 ? (
                    <span>No posts yet</span>
                  ) : (
                    <div className="flex h-full flex-col gap-2 overflow-hidden">
                    {dayPosts.map((post) => (
                      <div
                        key={post.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          openEditModal(post);
                        }}
                        className="rounded-xl border border-slate-200/70 bg-white/80 px-2 py-1 text-[11px] text-slate-700 shadow-sm transition hover:border-slate-300 hover:bg-white"
                      >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold text-slate-600">
                              {formatTime(post.scheduledAt)}
                            </span>
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-500">
                              {post.visibility}
                            </span>
                          </div>
                          <div className="mt-1 truncate text-slate-600">{post.text}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-6 py-8">
          <div className="w-full max-w-lg rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-xl font-semibold text-slate-900">Add post</h3>
                <p className="text-sm text-slate-500">
                  Scheduled for {formatDate(selectedDay)}
                </p>
              </div>
              <button
                onClick={closeModal}
                className="rounded-full border border-slate-200 px-3 py-1 text-sm text-slate-500 hover:border-slate-300 hover:text-slate-700"
              >
                Close
              </button>
            </div>

            <div className="mt-5 flex flex-col gap-4">
              <label className="flex flex-col gap-2 text-sm text-slate-600">
                Scheduled at
                <input
                  type="datetime-local"
                  value={formScheduledAt}
                  onChange={(event) => setFormScheduledAt(event.target.value)}
                  className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 outline-none focus:border-indigo-300"
                />
              </label>

              <label className="flex flex-col gap-2 text-sm text-slate-600">
                Text
                <textarea
                  value={formText}
                  onChange={(event) => setFormText(event.target.value)}
                  className="min-h-[120px] rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 outline-none focus:border-indigo-300"
                  placeholder="What do you want to share?"
                />
                <div className="text-xs text-slate-400">
                  {characterCount}/500 characters
                </div>
              </label>

              <label className="flex flex-col gap-2 text-sm text-slate-600">
                Visibility
                <select
                  value={formVisibility}
                  onChange={(event) =>
                    setFormVisibility(event.target.value as PlannedPost["visibility"])
                  }
                  className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 outline-none focus:border-indigo-300"
                >
                  <option value="public">Public</option>
                  <option value="unlisted">Unlisted</option>
                  <option value="private">Private</option>
                  <option value="direct">Direct</option>
                </select>
              </label>

              {formError && (
                <div className="rounded-xl border border-rose-100 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                  {formError}
                </div>
              )}

              <div className="flex items-center justify-end gap-3">
                <button
                  onClick={closeModal}
                  className="rounded-full border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:border-slate-300 hover:text-slate-800"
                >
                  Cancel
                </button>
                <div className="flex flex-col items-end gap-1">
                  <button
                    onClick={handleSubmit}
                    disabled={isSubmitDisabled}
                    className="rounded-full bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
                  >
                    {isSubmitting ? "Saving..." : "Save post"}
                  </button>
                  <span className="text-[11px] text-slate-400">Cmd/Ctrl+Enter to submit</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {activePost && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-6 py-8">
          <div className="w-full max-w-lg rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-xl font-semibold text-slate-900">Post details</h3>
                <p className="text-sm text-slate-500">
                  Editing post on {formatDate(new Date(activePost.scheduledAt))}
                </p>
              </div>
              <button
                onClick={closeEditModal}
                className="rounded-full border border-slate-200 px-3 py-1 text-sm text-slate-500 hover:border-slate-300 hover:text-slate-700"
              >
                Close
              </button>
            </div>

            <div className="mt-5 flex flex-col gap-4">
              <label className="flex flex-col gap-2 text-sm text-slate-600">
                Scheduled at
                <input
                  type="datetime-local"
                  value={editScheduledAt}
                  onChange={(event) => setEditScheduledAt(event.target.value)}
                  className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 outline-none focus:border-indigo-300"
                />
              </label>

              <label className="flex flex-col gap-2 text-sm text-slate-600">
                Text
                <textarea
                  value={editText}
                  onChange={(event) => setEditText(event.target.value)}
                  className="min-h-[120px] rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 outline-none focus:border-indigo-300"
                />
                <div className="text-xs text-slate-400">
                  {editCharacterCount}/500 characters
                </div>
              </label>

              <label className="flex flex-col gap-2 text-sm text-slate-600">
                Visibility
                <select
                  value={editVisibility}
                  onChange={(event) =>
                    setEditVisibility(event.target.value as PlannedPost["visibility"])
                  }
                  className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 outline-none focus:border-indigo-300"
                >
                  <option value="public">Public</option>
                  <option value="unlisted">Unlisted</option>
                  <option value="private">Private</option>
                  <option value="direct">Direct</option>
                </select>
              </label>

              {editError && (
                <div className="rounded-xl border border-rose-100 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                  {editError}
                </div>
              )}

              <div className="flex items-center justify-between gap-3">
                <button
                  onClick={handleDelete}
                  disabled={isDeleting}
                  className="rounded-full border border-rose-200 px-4 py-2 text-sm font-medium text-rose-600 transition hover:border-rose-300 hover:text-rose-700 disabled:cursor-not-allowed disabled:text-rose-300"
                >
                  {isDeleting ? "Deleting..." : "Delete"}
                </button>
                <button
                  onClick={handleUpdate}
                  disabled={isEditDisabled}
                  className="rounded-full bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  {isEditing ? "Saving..." : "Save changes"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
