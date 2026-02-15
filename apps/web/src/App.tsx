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

const getTimezoneLabel = () => {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offsetMinutes = -new Date().getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absMinutes = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absMinutes / 60)).padStart(2, "0");
  const minutes = String(absMinutes % 60).padStart(2, "0");
  return `${timeZone} (UTC${sign}${hours}:${minutes})`;
};

type PlannedPost = {
  id: string;
  instance: string;
  scheduledAt: string;
  text: string;
  visibility: "public" | "unlisted" | "private" | "direct";
  status: "draft" | "scheduled" | "sending" | "sent" | "failed" | "canceled";
  attempts: number;
  lastError?: string;
  sentAt?: string;
  remoteId?: string;
};

type AccountIdentity = {
  username: string;
  acct: string;
  displayName: string;
  avatar?: string;
};

type OnThisDayPost = {
  id: string;
  createdAt: string;
  text: string;
  visibility: "public" | "unlisted" | "private" | "direct";
  url?: string;
};

export default function App() {
  const getInitialInstance = () => {
    if (typeof window === "undefined") {
      return "https://mastodon.social";
    }
    const stored = window.localStorage.getItem("fedical.instance");
    return stored || "https://mastodon.social";
  };

  const [weekStartDate, setWeekStartDate] = useState<Date>(() => getWeekStart(new Date()));
  const [instance, setInstance] = useState(getInitialInstance);
  const [posts, setPosts] = useState<PlannedPost[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState<AccountIdentity | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [selectedDay, setSelectedDay] = useState<Date>(() => getWeekStart(new Date()));
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [formScheduledAt, setFormScheduledAt] = useState("");
  const [formText, setFormText] = useState("");
  const [formVisibility, setFormVisibility] =
    useState<PlannedPost["visibility"]>("public");
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasTriedSubmit, setHasTriedSubmit] = useState(false);
  const [activePost, setActivePost] = useState<PlannedPost | null>(null);
  const [editScheduledAt, setEditScheduledAt] = useState("");
  const [editText, setEditText] = useState("");
  const [editVisibility, setEditVisibility] =
    useState<PlannedPost["visibility"]>("public");
  const [editStatus, setEditStatus] = useState<PlannedPost["status"]>("draft");
  const [editError, setEditError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [hasTriedEditSubmit, setHasTriedEditSubmit] = useState(false);
  const [showSent, setShowSent] = useState(true);
  const [viewMode, setViewMode] = useState<"week" | "month">("week");
  const timezoneLabel = useMemo(() => getTimezoneLabel(), []);
  const [currentMonthDate, setCurrentMonthDate] = useState<Date>(() => new Date());

  const weekDates = useMemo(
    () =>
      dayLabels.map((label, index) => {
        const date = new Date(weekStartDate);
        date.setDate(weekStartDate.getDate() + index);
        return { label, date };
      }),
    [weekStartDate]
  );

  const monthGridDates = useMemo(() => {
    const firstOfMonth = new Date(currentMonthDate.getFullYear(), currentMonthDate.getMonth(), 1);
    const start = getWeekStart(firstOfMonth);
    const lastOfMonth = new Date(currentMonthDate.getFullYear(), currentMonthDate.getMonth() + 1, 0);
    const end = new Date(lastOfMonth);
    const dayIndex = (end.getDay() + 6) % 7;
    end.setHours(0, 0, 0, 0);
    end.setDate(end.getDate() + (6 - dayIndex));

    const dates: Date[] = [];
    const cursor = new Date(start);
    while (cursor <= end) {
      dates.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    return dates;
  }, [currentMonthDate]);

  const normalizeDate = (value: Date | string) => new Date(value);

  const isSameDay = (a: Date | string, b: Date | string) => {
    const dateA = normalizeDate(a);
    const dateB = normalizeDate(b);
    return (
      dateA.getFullYear() === dateB.getFullYear() &&
      dateA.getMonth() === dateB.getMonth() &&
      dateA.getDate() === dateB.getDate()
    );
  };

  const today = new Date();
  const todayStart = new Date(today);
  todayStart.setHours(0, 0, 0, 0);
  const onThisDayMonth = todayStart.getMonth();
  const onThisDayDate = todayStart.getDate();
  const onThisDayYear = todayStart.getFullYear();
  const safeSelectedDay = (() => {
    const normalized = normalizeDate(selectedDay);
    return Number.isNaN(normalized.getTime()) ? weekStartDate : normalized;
  })();

  const getRangeForView = () => {
    if (viewMode === "month") {
      const start = new Date(monthGridDates[0]);
      start.setHours(0, 0, 0, 0);
      const end = new Date(monthGridDates[monthGridDates.length - 1]);
      end.setHours(0, 0, 0, 0);
      end.setDate(end.getDate() + 1);
      return { from: start, to: end };
    }
    const from = new Date(weekStartDate);
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(from.getDate() + 7);
    return { from, to };
  };

  const fetchPosts = useCallback(
    async (signal?: AbortSignal) => {
      setIsLoading(true);
      setError(null);
      const { from, to } = getRangeForView();

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
        setError("Could not load posts for this view.");
        setPosts([]);
      } finally {
        setIsLoading(false);
      }
    },
    [instance, weekStartDate, viewMode, monthGridDates]
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
        )}&redirect=${encodeURIComponent(window.location.origin)}`
      );
      if (!authorizeRes.ok) {
        const data = (await authorizeRes.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? "Failed to build authorize URL");
      }
      const authorizeData = (await authorizeRes.json()) as { authorizeUrl: string };

      window.location.assign(authorizeData.authorizeUrl);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Failed to connect");
    } finally {
      setIsConnecting(false);
    }
  };

  const handleLogout = async () => {
    setIsLoggingOut(true);
    setAuthError(null);
    try {
      const res = await fetch("/auth/logout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instance }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? "Failed to log out");
      }
      setAccount(null);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Failed to log out");
    } finally {
      setIsLoggingOut(false);
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

  const [onThisDayPosts, setOnThisDayPosts] = useState<OnThisDayPost[]>([]);
  const [onThisDayLoading, setOnThisDayLoading] = useState(false);
  const [onThisDayError, setOnThisDayError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const loadOnThisDay = async () => {
      if (!account) {
        setOnThisDayPosts([]);
        setOnThisDayError(null);
        setOnThisDayLoading(false);
        return;
      }

      setOnThisDayLoading(true);
      setOnThisDayError(null);
      const url =
        "/posts/on-this-day?instance=" +
        encodeURIComponent(instance) +
        "&month=" +
        encodeURIComponent(String(onThisDayMonth + 1)) +
        "&day=" +
        encodeURIComponent(String(onThisDayDate)) +
        "&beforeYear=" +
        encodeURIComponent(String(onThisDayYear));

      try {
        const res = await fetch(url, { signal: controller.signal });
        if (res.status === 401) {
          setOnThisDayPosts([]);
          return;
        }
        if (!res.ok) {
          throw new Error(`Failed to load post history (${res.status})`);
        }
        const data = (await res.json()) as { posts?: OnThisDayPost[] };
        setOnThisDayPosts(Array.isArray(data.posts) ? data.posts : []);
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return;
        }
        setOnThisDayError("Could not load On This Day posts.");
        setOnThisDayPosts([]);
      } finally {
        setOnThisDayLoading(false);
      }
    };

    void loadOnThisDay();
    return () => controller.abort();
  }, [account, instance, onThisDayDate, onThisDayMonth, onThisDayYear]);

  const formatTime = (iso: string) => {
    const date = new Date(iso);
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
  };

  const formatLongDate = (iso: string) => {
    const date = new Date(iso);
    return date.toLocaleDateString(undefined, {
      weekday: "short",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  };

  const statusBadgeStyles: Record<PlannedPost["status"], string> = {
    draft: "bg-slate-100 text-slate-700 border border-slate-200",
    scheduled: "bg-amber-100 text-amber-800 border border-amber-200",
    sending: "bg-indigo-100 text-indigo-800 border border-indigo-200",
    sent: "bg-emerald-100 text-emerald-800 border border-emerald-200",
    failed: "bg-rose-100 text-rose-800 border border-rose-200",
    canceled: "bg-slate-200 text-slate-600 border border-slate-300",
  };

  const getDefaultScheduledAt = (day: Date | string) => {
    const now = new Date();
    const rounded = new Date(now);
    rounded.setSeconds(0, 0);
    const minutes = rounded.getMinutes();
    const nextQuarter = Math.ceil((minutes + 1) / 15) * 15;
    rounded.setMinutes(nextQuarter);

    const target = normalizeDate(day);
    if (Number.isNaN(target.getTime())) {
      return getLocalDateTimeValue(rounded.toISOString());
    }
    target.setHours(rounded.getHours(), rounded.getMinutes(), 0, 0);
    return getLocalDateTimeValue(target.toISOString());
  };

  const getRoundedNowValue = () => {
    const now = new Date();
    const rounded = new Date(now);
    rounded.setSeconds(0, 0);
    const minutes = rounded.getMinutes();
    const nextQuarter = Math.ceil((minutes + 1) / 15) * 15;
    rounded.setMinutes(nextQuarter);
    return getLocalDateTimeValue(rounded.toISOString());
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
    const targetDay = dayOverride ? normalizeDate(dayOverride) : normalizeDate(selectedDay);
    if (dayOverride) {
      setSelectedDay(targetDay);
    }
    setFormError(null);
    setHasTriedSubmit(false);
    setFormText("");
    setFormVisibility("public");
    setFormScheduledAt(getDefaultScheduledAt(targetDay));
    setIsModalOpen(true);
  };

  const openEditModal = (post: PlannedPost) => {
    setActivePost(post);
    setEditError(null);
    setHasTriedEditSubmit(false);
    setEditText(post.text);
    setEditVisibility(post.visibility);
    setEditScheduledAt(getLocalDateTimeValue(post.scheduledAt));
    setEditStatus(post.status);
  };

  const openRetryModal = (post: PlannedPost) => {
    const now = new Date();
    const minScheduled = new Date(now.getTime() + 2 * 60_000);
    const existing = new Date(post.scheduledAt);
    const target =
      Number.isNaN(existing.getTime()) || existing.getTime() < minScheduled.getTime()
        ? minScheduled
        : existing;
    setActivePost(post);
    setEditError(null);
    setHasTriedEditSubmit(false);
    setEditText(post.text);
    setEditVisibility(post.visibility);
    setEditStatus("scheduled");
    setEditScheduledAt(getLocalDateTimeValue(target.toISOString()));
  };

  const closeEditModal = () => {
    setActivePost(null);
    setEditError(null);
    setIsEditing(false);
    setIsDeleting(false);
    setHasTriedEditSubmit(false);
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setFormError(null);
    setHasTriedSubmit(false);
  };

  const handleSubmit = useCallback(async () => {
    setHasTriedSubmit(true);
    if (formText.trim().length === 0 || formText.length > 500) {
      return;
    }
    const scheduledValue = new Date(formScheduledAt);
    if (Number.isNaN(scheduledValue.getTime())) {
      setFormError("Scheduled time must be valid.");
      return;
    }
    if (scheduledValue.getTime() <= Date.now()) {
      setFormError("Scheduled time must be in the future.");
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
    setHasTriedEditSubmit(true);
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
    if (parsed.getTime() <= Date.now() && editStatus === "scheduled") {
      setEditError("Scheduled time must be in the future.");
      return;
    }
    setIsEditing(true);
    setEditError(null);
    try {
      const payload = {
        scheduledAt: new Date(editScheduledAt).toISOString(),
        text: editText.trim(),
        visibility: editVisibility,
        status: editStatus,
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

  const shiftMonth = (direction: number) => {
    setCurrentMonthDate((current) => {
      const next = new Date(current.getFullYear(), current.getMonth() + direction, 1);
      return next;
    });
  };

  const formatMonthTitle = (date: Date) =>
    date.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const characterCount = formText.length;
  const submitDisabledReason = (() => {
    if (isSubmitting) {
      return "Saving post...";
    }
    if (formText.trim().length === 0) {
      return "Text is required.";
    }
    if (characterCount > 500) {
      return "Text must be 500 characters or less.";
    }
    if (!formScheduledAt) {
      return "Scheduled time is required.";
    }
    const parsed = new Date(formScheduledAt);
    if (Number.isNaN(parsed.getTime())) {
      return "Scheduled time must be valid.";
    }
    if (parsed.getTime() <= Date.now()) {
      return "Scheduled time must be in the future.";
    }
    return "";
  })();
  const isSubmitDisabled = submitDisabledReason !== "";
  const editCharacterCount = editText.length;
  const editDisabledReason = (() => {
    if (isEditing) {
      return "Saving changes...";
    }
    if (editStatus === "scheduled") {
      const parsed = new Date(editScheduledAt);
      if (parsed.getTime() <= Date.now()) {
        return "Scheduled time must be in the future.";
      }
    }
    if (editText.trim().length === 0) {
      return "Text is required.";
    }
    if (editCharacterCount > 500) {
      return "Text must be 500 characters or less.";
    }
    if (!editScheduledAt) {
      return "Scheduled time is required.";
    }
    const parsed = new Date(editScheduledAt);
    if (Number.isNaN(parsed.getTime())) {
      return "Scheduled time must be valid.";
    }
    if (parsed.getTime() <= Date.now() && editStatus === "scheduled") {
      return "Scheduled time must be in the future.";
    }
    return "";
  })();
  const isEditDisabled = editDisabledReason !== "";

  useEffect(() => {
    if (!hasTriedSubmit) {
      return;
    }
    if (!isSubmitDisabled) {
      setHasTriedSubmit(false);
    }
  }, [hasTriedSubmit, isSubmitDisabled]);

  useEffect(() => {
    if (!hasTriedEditSubmit) {
      return;
    }
    if (!isEditDisabled) {
      setHasTriedEditSubmit(false);
    }
  }, [hasTriedEditSubmit, isEditDisabled]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem("fedical.instance", instance);
  }, [instance]);

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
                    <button
                      onClick={handleLogout}
                      disabled={isLoggingOut}
                      className="rounded-full border border-slate-200 px-2 py-0.5 text-[10px] font-medium text-slate-500 transition hover:border-slate-300 hover:text-slate-700 disabled:cursor-not-allowed disabled:text-slate-300"
                    >
                      {isLoggingOut ? "Logging out..." : "Log out"}
                    </button>
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
              {viewMode === "week" ? (
                <>
                  <h2 className="text-2xl font-semibold text-slate-900">
                    Week of {formatDate(weekStartDate)}
                  </h2>
                  <p className="text-sm text-slate-500">Draft a week of thoughtful posts.</p>
                </>
              ) : (
                <>
                  <h2 className="text-2xl font-semibold text-slate-900">
                    {formatMonthTitle(currentMonthDate)}
                  </h2>
                  <p className="text-sm text-slate-500">Monthly overview of scheduled posts.</p>
                </>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex overflow-hidden rounded-full border border-slate-200 text-sm">
                <button
                  onClick={() => setViewMode("week")}
                  className={`px-4 py-2 font-medium transition ${
                    viewMode === "week"
                      ? "bg-slate-900 text-white"
                      : "bg-white text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  Week
                </button>
                <button
                  onClick={() => setViewMode("month")}
                  className={`px-4 py-2 font-medium transition ${
                    viewMode === "month"
                      ? "bg-slate-900 text-white"
                      : "bg-white text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  Month
                </button>
              </div>
              <button
                onClick={() => setShowSent((current) => !current)}
                className="rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
              >
                {showSent ? "Hide sent" : "Show sent"}
              </button>
              <button
                onClick={() => openModal()}
                className="rounded-full border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-medium text-indigo-700 transition hover:border-indigo-300 hover:bg-indigo-100"
              >
                Add post
              </button>
              <button
                onClick={() => (viewMode === "week" ? shiftWeek(-1) : shiftMonth(-1))}
                className="rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
              >
                {viewMode === "week" ? "Prev week" : "Prev month"}
              </button>
              <button
                onClick={() => (viewMode === "week" ? shiftWeek(1) : shiftMonth(1))}
                className="rounded-full bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-slate-800"
              >
                {viewMode === "week" ? "Next week" : "Next month"}
              </button>
            </div>
          </div>
        </header>

        <section className="rounded-3xl border border-slate-200 bg-white/70 p-6 shadow-[0_16px_50px_rgba(15,23,42,0.06)]">
          {viewMode === "week" ? (
            <>
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
                  const dayPosts = (postsByDay.get(dayKey) ?? []).filter(
                    (post) => showSent || post.status !== "sent"
                  );
                  const isSelected = isSameDay(day.date, selectedDay);
                  const isPastDay = day.date.getTime() < todayStart.getTime();
                  return (
                    <div
                      key={`${day.label}-cell`}
                      onClick={() => {
                        if (!isPastDay) {
                          openModal(day.date);
                        }
                      }}
                      className={`h-32 rounded-2xl border border-dashed p-3 text-xs shadow-inner transition ${
                        isSameDay(day.date, today)
                          ? "border-indigo-400 bg-indigo-50/80 text-indigo-600 shadow-[0_0_0_2px_rgba(99,102,241,0.15)]"
                          : "border-slate-200 bg-white/90 text-slate-400 hover:border-slate-300 hover:bg-white"
                      } ${isSelected ? "ring-2 ring-indigo-200" : ""} ${
                        isPastDay ? "cursor-not-allowed opacity-60" : "cursor-pointer"
                      }`}
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
                                <div className="flex items-center gap-1">
                                  <span
                                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${statusBadgeStyles[post.status]}`}
                                  >
                                    {post.status}
                                  </span>
                                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-500">
                                    {post.visibility}
                                  </span>
                                </div>
                              </div>
                              <div className="mt-1 truncate text-slate-600">{post.text}</div>
                              {post.status === "sending" && (
                                <div className="mt-1 text-[10px] text-indigo-600">Sending…</div>
                              )}
                              {post.status === "failed" && (
                                <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-rose-600">
                                  <span>
                                    {post.lastError ?? "Failed"} · attempts {post.attempts}
                                  </span>
                                  <button
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      openRetryModal(post);
                                    }}
                                    className="rounded-full border border-rose-200 px-2 py-0.5 text-[10px] font-semibold text-rose-600 hover:border-rose-300 hover:text-rose-700"
                                  >
                                    Retry
                                  </button>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              {isLoading && (
                <div className="mb-4 rounded-2xl border border-indigo-100 bg-indigo-50/70 px-4 py-3 text-sm text-indigo-700">
                  Loading posts for this month...
                </div>
              )}
              {error && (
                <div className="mb-4 rounded-2xl border border-rose-100 bg-rose-50/80 px-4 py-3 text-sm text-rose-700">
                  {error}
                </div>
              )}
              <div className="grid grid-cols-7 gap-4 text-sm font-semibold text-slate-500">
                {dayLabels.map((day) => (
                  <div key={day} className="text-center">
                    {day}
                  </div>
                ))}
              </div>
              <div className="mt-4 grid grid-cols-7 gap-3">
                {monthGridDates.map((date) => {
                  const isOutside = date.getMonth() !== currentMonthDate.getMonth();
                  const isToday = isSameDay(date, today);
                  const dayKey = formatDate(date);
                  const dayPosts = (postsByDay.get(dayKey) ?? []).filter(
                    (post) => showSent || post.status !== "sent"
                  );
                  const visiblePosts = dayPosts.slice(0, 2);
                  const overflowCount = dayPosts.length - visiblePosts.length;
                  return (
                    <div
                      key={date.toISOString()}
                      onClick={() => openModal(date)}
                      className={`h-28 rounded-2xl border border-dashed p-3 text-xs transition ${
                        isOutside ? "border-slate-100 text-slate-300" : "border-slate-200 text-slate-500"
                      } ${isToday ? "bg-indigo-50/70 text-indigo-600" : "bg-white"} cursor-pointer hover:border-slate-300`}
                    >
                      <div className="text-sm font-semibold">{date.getDate()}</div>
                      <div className="mt-2 flex flex-col gap-1">
                        {visiblePosts.map((post) => (
                          <div
                            key={post.id}
                            onClick={(event) => {
                              event.stopPropagation();
                              openEditModal(post);
                            }}
                            className="flex items-center gap-1 overflow-hidden rounded-full border border-slate-200/70 bg-white/80 px-2 py-0.5 text-[10px] text-slate-600 shadow-sm"
                          >
                            <span className="shrink-0 font-semibold">{formatTime(post.scheduledAt)}</span>
                            <span className="shrink-0 text-slate-400">·</span>
                            <span className="min-w-0 flex-1 truncate">
                              {post.text}
                            </span>
                            <span
                              className={`ml-1 shrink-0 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${statusBadgeStyles[post.status]}`}
                            >
                              {post.status}
                            </span>
                          </div>
                        ))}
                        {overflowCount > 0 && (
                          <div className="text-[10px] text-slate-400">+{overflowCount} more</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white/70 p-6 shadow-[0_16px_50px_rgba(15,23,42,0.06)]">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h3 className="text-xl font-semibold text-slate-900">On This Day</h3>
              <p className="text-sm text-slate-500">
                Your fediverse posts from {todayStart.toLocaleDateString(undefined, { month: "long", day: "numeric" })} in previous years.
              </p>
            </div>
          </div>

          {!account ? (
            <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
              Connect an account to view your On This Day history.
            </div>
          ) : onThisDayLoading ? (
            <div className="mt-4 rounded-2xl border border-indigo-100 bg-indigo-50/70 px-4 py-3 text-sm text-indigo-700">
              Loading On This Day posts...
            </div>
          ) : onThisDayError ? (
            <div className="mt-4 rounded-2xl border border-rose-100 bg-rose-50/80 px-4 py-3 text-sm text-rose-700">
              {onThisDayError}
            </div>
          ) : onThisDayPosts.length === 0 ? (
            <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
              No posts found for this date in previous years.
            </div>
          ) : (
            <div className="mt-4 grid gap-3">
              {onThisDayPosts.map((post) => (
                <div
                  key={`history-${post.id}`}
                  className="rounded-2xl border border-slate-200 bg-white/90 px-4 py-3 shadow-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                    <span className="font-semibold text-slate-700">{formatLongDate(post.createdAt)}</span>
                    <div className="flex items-center gap-2">
                      <span>{formatTime(post.createdAt)}</span>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 uppercase tracking-wide text-slate-600">
                        {post.visibility}
                      </span>
                    </div>
                  </div>
                  <p className="mt-2 text-sm text-slate-700">{post.text}</p>
                  {post.url && (
                    <a
                      href={post.url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-2 inline-flex text-xs font-medium text-indigo-600 hover:text-indigo-700"
                    >
                      View on instance
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-6 py-8">
          <div className="w-full max-w-lg rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-xl font-semibold text-slate-900">Add post</h3>
                <p className="text-sm text-slate-500">
                  Scheduled for {formatDate(safeSelectedDay)}
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
                <div className="flex items-center justify-between text-sm">
                  <span>Scheduled at</span>
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    <span>{timezoneLabel}</span>
                    <button
                      type="button"
                      onClick={() => setFormScheduledAt(getRoundedNowValue())}
                      className="rounded-full border border-slate-200 px-2 py-0.5 text-[10px] text-slate-500 hover:border-slate-300 hover:text-slate-700"
                    >
                      Today
                    </button>
                  </div>
                </div>
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

              <div className="flex items-end justify-between gap-4">
                <span className="text-[11px] text-slate-400">Cmd/Ctrl+Enter to submit</span>
                <div className="flex items-end gap-3">
                  <button
                    onClick={closeModal}
                    className="rounded-full border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:border-slate-300 hover:text-slate-800"
                  >
                    Cancel
                  </button>
                  <div className="flex flex-col items-end gap-1">
                    <span className="h-4 text-[11px] text-rose-500">
                      {hasTriedSubmit && isSubmitDisabled ? submitDisabledReason : "\u00A0"}
                    </span>
                    <button
                      onClick={handleSubmit}
                      disabled={isSubmitDisabled}
                      className="rounded-full bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
                    >
                      {isSubmitting ? "Saving..." : "Save post"}
                    </button>
                  </div>
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
                <div className="flex items-center justify-between text-sm">
                  <span>Scheduled at</span>
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    <span>{timezoneLabel}</span>
                    <button
                      type="button"
                      onClick={() => setEditScheduledAt(getRoundedNowValue())}
                      className="rounded-full border border-slate-200 px-2 py-0.5 text-[10px] text-slate-500 hover:border-slate-300 hover:text-slate-700"
                    >
                      Today
                    </button>
                  </div>
                </div>
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
              {activePost.status === "sent" ? (
                <div className="flex items-center justify-between rounded-xl border border-emerald-100 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                  <span>Status</span>
                  <span className="font-semibold">Sent</span>
                </div>
              ) : (
                <label className="flex flex-col gap-2 text-sm text-slate-600">
                  Status
                  <select
                    value={editStatus}
                    onChange={(event) =>
                      setEditStatus(event.target.value as PlannedPost["status"])
                    }
                    className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 outline-none focus:border-indigo-300"
                  >
                    <option value="draft">Draft</option>
                    <option value="scheduled">Scheduled</option>
                    <option value="canceled">Canceled</option>
                  </select>
                </label>
              )}

              {editError && (
                <div className="rounded-xl border border-rose-100 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                  {editError}
                </div>
              )}

              <div className="flex items-end justify-between gap-3">
                <button
                  onClick={handleDelete}
                  disabled={isDeleting}
                  className="rounded-full border border-rose-200 px-4 py-2 text-sm font-medium text-rose-600 transition hover:border-rose-300 hover:text-rose-700 disabled:cursor-not-allowed disabled:text-rose-300"
                >
                  {isDeleting ? "Deleting..." : "Delete"}
                </button>
                <div className="flex flex-col items-end gap-1 text-right">
                  <span className="h-4 text-[11px] text-rose-500">
                    {hasTriedEditSubmit && isEditDisabled ? editDisabledReason : "\u00A0"}
                  </span>
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
        </div>
      )}
    </div>
  );
}
