"""
Owns the rclpy lifecycle for the whole FastAPI process.
"""
from __future__ import annotations

import threading
from typing import Optional

import rclpy
from rclpy.executors import MultiThreadedExecutor
from rclpy.node import Node


class RosManager:
    def __init__(self) -> None:
        self._executor: Optional[MultiThreadedExecutor] = None
        self._thread: Optional[threading.Thread] = None
        self._introspection_node: Optional[Node] = None
        self._started = False
        self._lock = threading.Lock()

    def start(self) -> None:
        with self._lock:
            if self._started:
                return
            # Guard against rclpy already being initialized in this process
            # (can happen with uvicorn --reload).
            if not rclpy.ok():
                rclpy.init()

            self._executor = MultiThreadedExecutor()
            self._introspection_node = Node("dashboard_introspector")
            self._executor.add_node(self._introspection_node)

            self._thread = threading.Thread(
                target=self._executor.spin, name="rclpy-executor", daemon=True
            )
            self._thread.start()
            self._started = True

    def shutdown(self) -> None:
        with self._lock:
            if not self._started:
                return
            self._started = False

            # 1. Stop the executor first so spin() returns and the thread can exit.
            if self._executor is not None:
                try:
                    self._executor.shutdown()
                except Exception:
                    pass

            # 2. Destroy nodes we created.
            if self._introspection_node is not None:
                try:
                    self._introspection_node.destroy_node()
                except Exception:
                    pass
                self._introspection_node = None

            # 3. Only call rclpy.shutdown() if the context is still alive.
            try:
                if rclpy.ok():
                    rclpy.shutdown()
            except Exception:
                # Context was already torn down (e.g. by the reloader). Ignore.
                pass

            self._executor = None
            self._thread = None

    @property
    def introspection_node(self) -> Node:
        if self._introspection_node is None:
            raise RuntimeError("RosManager not started")
        return self._introspection_node

    def add_node(self, node: Node) -> None:
        if self._executor is None:
            raise RuntimeError("RosManager not started")
        self._executor.add_node(node)

    def remove_node(self, node: Node) -> None:
        if self._executor is not None:
            try:
                self._executor.remove_node(node)
            except Exception:
                pass


ros_manager = RosManager()