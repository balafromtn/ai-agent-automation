"use client";

import { useEffect, useRef } from "react";

export function usePerformanceMonitor(componentName: string) {
  const renderCount = useRef(0);
  const lastRenderTime = useRef(Date.now());

  useEffect(() => {
    renderCount.current += 1;
    const now = Date.now();
    const timeSinceLastRender = now - lastRenderTime.current;
    
    console.debug(
      `[Profiler] ⚡ ${componentName} | Render: #${renderCount.current} | Time since last: ${timeSinceLastRender}ms`
    );
    
    lastRenderTime.current = now;
  });
}