import asyncio
import unittest

from dashboard_loopback_proxy import start_proxy


class DashboardLoopbackProxyTests(unittest.IsolatedAsyncioTestCase):
    async def test_forwards_http_bytes_to_loopback_dashboard(self):
        async def upstream(reader, writer):
            request = await reader.readuntil(b"\r\n\r\n")
            self.assertIn(b"GET /api/health HTTP/1.1", request)
            writer.write(
                b"HTTP/1.1 200 OK\r\n"
                b"Content-Type: application/json\r\n"
                b"Content-Length: 11\r\n"
                b"Connection: close\r\n\r\n"
                b'{"ok":true}'
            )
            await writer.drain()
            writer.close()
            await writer.wait_closed()

        upstream_server = await asyncio.start_server(upstream, "127.0.0.1", 0)
        upstream_port = upstream_server.sockets[0].getsockname()[1]
        proxy = await start_proxy("127.0.0.1", 0, "127.0.0.1", upstream_port)
        proxy_port = proxy.sockets[0].getsockname()[1]
        try:
            reader, writer = await asyncio.open_connection("127.0.0.1", proxy_port)
            writer.write(
                b"GET /api/health HTTP/1.1\r\n"
                b"Host: 127.0.0.1:9119\r\n"
                b"Connection: close\r\n\r\n"
            )
            await writer.drain()
            response = await reader.read()
            self.assertIn(b"HTTP/1.1 200 OK", response)
            self.assertTrue(response.endswith(b'{"ok":true}'))
            writer.close()
            await writer.wait_closed()
        finally:
            proxy.close()
            await proxy.wait_closed()
            upstream_server.close()
            await upstream_server.wait_closed()


if __name__ == "__main__":
    unittest.main()
