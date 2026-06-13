<script lang="ts">
  import { onMount } from "svelte";
  import { SUPPORTED_LANGS, type LangCode } from "@i18n/client";
  import { currentLang } from "@i18n/store";

  let open = $state(false);

  onMount(() => {
    // Apply saved language to Astro-rendered DOM on mount
    const lang = $currentLang;
    if ((window as any).__applyI18n) {
      (window as any).__applyI18n(lang);
    }
    if ((window as any).__I18N_DATA__) {
      (window as any).__I18N_DATA__.current = lang;
    }
  });

  function switchLang(lang: LangCode) {
    currentLang.set(lang);
    open = false;
    localStorage.setItem("fuwari-lang", lang);
    if ((window as any).__applyI18n) {
      (window as any).__applyI18n(lang);
    }
  }

  function toggleOpen() {
    open = !open;
  }

  const labelMap: Record<LangCode, string> = {
    en: "EN",
    zh_CN: "中",
    ja: "日",
    de: "DE",
  };
</script>

<div class="relative">
  <button
    aria-label="Switch language"
    class="btn-plain scale-animation rounded-lg h-11 w-11 active:scale-90 font-bold text-sm"
    onclick={toggleOpen}
  >
    {labelMap[$currentLang] ?? "EN"}
  </button>

  {#if open}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="absolute right-0 top-12 z-50 card-base float-panel min-w-[7rem] py-1 shadow-lg"
      onmouseleave={() => (open = false)}
    >
      {#each SUPPORTED_LANGS as lang}
        <button
          class="w-full text-left px-4 py-2 text-sm btn-plain rounded-none
            {$currentLang === lang.code ? 'text-[var(--primary)] font-bold' : ''}"
          onclick={() => switchLang(lang.code)}
        >
          {lang.label}
        </button>
      {/each}
    </div>
  {/if}
</div>
