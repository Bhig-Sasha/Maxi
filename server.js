// ============================================
// MAXIFLAIR.NG - Backend API Server (Guest-Only)
// ============================================

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// SUPABASE CONFIGURATION
// ============================================
// Service role key: full DB access, bypasses RLS.
// NEVER expose this to the frontend.
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

// ============================================
// CONSTANTS
// ============================================
const CONSTANTS = {
  ORDER_STATUS: {
    PENDING:    'Pending',
    PROCESSING: 'Processing',
    SHIPPED:    'Shipped',
    DELIVERED:  'Delivered',
    CANCELLED:  'Cancelled'
  },
  FREE_SHIPPING_THRESHOLD: 50000,
  SHIPPING_FEE: 3500,
  SESSION_COOKIE: 'mxf_sid',
  SESSION_MAX_AGE: 1000 * 60 * 60 * 24 * 90 // 90 days
};

// ============================================
// MIDDLEWARE
// ============================================
app.use(helmet({ contentSecurityPolicy: false }));

// CORS — allow Vercel frontends to send cookies
const allowedOrigins = (process.env.ALLOWED_ORIGINS ||
  'https://maxi-flair.vercel.app,https://maxiflair.vercel.app,http://localhost:5173,http://localhost:3000')
  .split(',').map(o => o.trim());

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (process.env.NODE_ENV !== 'production') return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    console.warn('CORS blocked:', origin);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  maxAge: 86400
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());
app.use(morgan('dev'));

// ============================================
// GUEST SESSION MIDDLEWARE
// ============================================
// Sets an httpOnly cookie `mxf_sid` on first visit. Every cart/order
// query filters by this session ID. No accounts, no passwords.
function guestSession(req, res, next) {
  let sid = req.cookies?.[CONSTANTS.SESSION_COOKIE];
  if (!sid || typeof sid !== 'string' || sid.length < 16) {
    sid = 'sess_' + crypto.randomBytes(16).toString('hex');
    res.cookie(CONSTANTS.SESSION_COOKIE, sid, {
      httpOnly: true,
      sameSite: 'none',              // required for cross-site Vercel → Render
      secure: process.env.NODE_ENV === 'production',
      maxAge: CONSTANTS.SESSION_MAX_AGE,
      path: '/'
    });
  }
  req.sessionId = sid;
  next();
}
app.use(guestSession);

// ============================================
// VALIDATION
// ============================================
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  return res.status(400).json({
    success: false,
    errors: errors.array().map(e => ({ field: e.path, message: e.msg }))
  });
};

const validations = {
  guestOrder: [
    body('fullName').trim().notEmpty().withMessage('Full name is required'),
    body('email').trim().notEmpty().withMessage('Email is required')
      .isEmail().withMessage('Please provide a valid email'),
    body('phone').trim().notEmpty().withMessage('Phone number is required'),
    body('address.line1').trim().notEmpty().withMessage('Street address is required'),
    body('address.city').trim().notEmpty().withMessage('City is required'),
    body('address.state').trim().notEmpty().withMessage('State is required'),
    validate
  ]
};

// ============================================
// HELPERS
// ============================================
const formatProduct = (p) => {
  if (!p) return null;
  const hasSale = p.sale_price !== null && p.sale_price !== undefined &&
                  Number(p.sale_price) < Number(p.price);
  return {
    ...p,
    images: p.images || [],
    image_url: (p.images && p.images[0]) || null,
    effective_price: hasSale ? Number(p.sale_price) : Number(p.price),
    on_sale: hasSale
  };
};

const generateOrderNumber = () => {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `MXF-${d}-${rand}`;
};

const generateTrackingCode = () => {
  return 'TRK-' + crypto.randomBytes(4).toString('hex').toUpperCase();
};

const calculateShipping = (subtotal) => {
  return subtotal >= CONSTANTS.FREE_SHIPPING_THRESHOLD ? 0 : CONSTANTS.SHIPPING_FEE;
};

// ============================================
// MODELS
// ============================================

// ---------- PRODUCTS ----------
const Product = {
  // Fetch products with images + variants merged into flat arrays
  findAll: async (filters = {}) => {
    const { category, limit = 20, offset = 0, sort = 'newest' } = filters;

    let query = supabase
      .from('products')
      .select(`
        *,
        product_images(image_url, display_order),
        product_variants(size, color, stock)
      `)
      .eq('is_active', true)
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (category && category !== 'All') {
      if (category === 'New Arrivals' || category === 'Best Sellers') {
        query = query.contains('tags', [category]);
      } else {
        // Match by category name via a lookup
        const { data: cat } = await supabase
          .from('categories').select('id').eq('name', category).maybeSingle();
        if (cat) query = query.eq('category_id', cat.id);
        else query = query.eq('category_id', '00000000-0000-0000-0000-000000000000');
      }
    }

    switch (sort) {
      case 'price-low':   query = query.order('price', { ascending: true }); break;
      case 'price-high':  query = query.order('price', { ascending: false }); break;
      case 'best-selling':query = query.order('review_count', { ascending: false }); break;
      default:            query = query.order('created_at', { ascending: false });
    }

    const { data, error } = await query;
    if (error) throw error;

    // Flatten images + variants
    return (data || []).map(p => {
      const images = (p.product_images || [])
        .sort((a, b) => (a.display_order || 0) - (b.display_order || 0))
        .map(i => i.image_url);
      return formatProduct({
        ...p,
        images,
        colors: p.colors || [],
        sizes: p.sizes || []
      });
    });
  },

  findById: async (id) => {
    const { data, error } = await supabase
      .from('products')
      .select(`
        *,
        product_images(image_url, display_order),
        product_variants(id, size, color, stock)
      `)
      .eq('id', id)
      .eq('is_active', true)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;

    const images = (data.product_images || [])
      .sort((a, b) => (a.display_order || 0) - (b.display_order || 0))
      .map(i => i.image_url);

    return formatProduct({ ...data, images });
  },

  search: async (q) => {
    const { data, error } = await supabase
      .from('products')
      .select(`*, product_images(image_url, display_order)`)
      .eq('is_active', true)
      .or(`name.ilike.%${q}%,description.ilike.%${q}%`)
      .order('created_at', { ascending: false })
      .limit(10);
    if (error) throw error;

    return (data || []).map(p => {
      const images = (p.product_images || [])
        .sort((a, b) => (a.display_order || 0) - (b.display_order || 0))
        .map(i => i.image_url);
      return formatProduct({ ...p, images });
    });
  },

  getReviews: async (productId) => {
    const { data, error } = await supabase
      .from('reviews')
      .select('id, product_id, user_name, rating, comment, created_at')
      .eq('product_id', productId)
      .eq('is_approved', true)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  },

  addReview: async ({ productId, userName, email, rating, comment }) => {
    const { data, error } = await supabase
      .from('reviews')
      .insert([{
        product_id: productId,
        user_name: userName,
        user_email: email || null,
        rating: Number(rating),
        comment: comment || '',
        is_approved: true
      }])
      .select('*')
      .single();
    if (error) throw error;
    return data;
  }
};

// ---------- CART ----------
const Cart = {
  getItems: async (sessionId) => {
    const { data, error } = await supabase
      .from('cart_items')
      .select(`
        id, quantity, size, color, created_at,
        product:products(
          id, name, price, sale_price, in_stock, tags,
          product_images(image_url, display_order)
        )
      `)
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false });
    if (error) throw error;

    return (data || []).map(item => {
      const p = item.product;
      const images = (p?.product_images || [])
        .sort((a, b) => (a.display_order || 0) - (b.display_order || 0))
        .map(i => i.image_url);
      const price = p?.sale_price != null && p.sale_price < p.price
        ? Number(p.sale_price) : Number(p?.price || 0);
      return {
        id: item.id,
        product_id: p?.id,
        name: p?.name,
        image_url: images[0] || null,
        price,
        quantity: item.quantity,
        size: item.size,
        color: item.color,
        line_total: price * item.quantity,
        in_stock: p?.in_stock ?? true
      };
    });
  },

  addItem: async (sessionId, productId, quantity = 1, size = null, color = null) => {
    const { data: product, error: pErr } = await supabase
      .from('products').select('id, in_stock').eq('id', productId).maybeSingle();
    if (pErr) throw pErr;
    if (!product) throw new Error('Product not found');
    if (!product.in_stock) throw new Error('Product is out of stock');

    // Look for matching row (same product + size + color)
    let q = supabase.from('cart_items').select('id, quantity')
      .eq('session_id', sessionId).eq('product_id', productId);
    q = size  ? q.eq('size', size)   : q.is('size', null);
    q = color ? q.eq('color', color) : q.is('color', null);

    const { data: existing, error: eErr } = await q.maybeSingle();
    if (eErr) throw eErr;

    if (existing) {
      const { error } = await supabase.from('cart_items')
        .update({ quantity: existing.quantity + quantity, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
      if (error) throw error;
    } else {
      const { error } = await supabase.from('cart_items').insert([{
        session_id: sessionId,
        product_id: productId,
        quantity: Number(quantity) || 1,
        size: size || null,
        color: color || null
      }]);
      if (error) throw error;
    }
    return true;
  },

  updateQuantity: async (sessionId, itemId, quantity) => {
    if (quantity <= 0) {
      const { error } = await supabase.from('cart_items')
        .delete().eq('session_id', sessionId).eq('id', itemId);
      if (error) throw error;
    } else {
      const { error } = await supabase.from('cart_items')
        .update({ quantity, updated_at: new Date().toISOString() })
        .eq('session_id', sessionId).eq('id', itemId);
      if (error) throw error;
    }
    return true;
  },

  removeItem: async (sessionId, itemId) => {
    const { error } = await supabase.from('cart_items')
      .delete().eq('session_id', sessionId).eq('id', itemId);
    if (error) throw error;
    return true;
  },

  clear: async (sessionId) => {
    const { error } = await supabase.from('cart_items')
      .delete().eq('session_id', sessionId);
    if (error) throw error;
    return true;
  }
};

// ---------- ORDERS ----------
const Order = {
  create: async (sessionId, customer, opts = {}) => {
    // 1. Pull cart
    const items = await Cart.getItems(sessionId);
    if (!items.length) throw new Error('Your cart is empty');

    // 2. Compute totals
    const subtotal = items.reduce((s, i) => s + i.line_total, 0);
    const shippingFee = opts.shippingFee != null
      ? Number(opts.shippingFee)
      : calculateShipping(subtotal);
    const total = subtotal + shippingFee;

    // 3. Insert order (order_number + tracking_code auto-set by DB default)
    const { data: order, error: oErr } = await supabase
      .from('orders')
      .insert([{
        session_id: sessionId,
        customer_name: customer.fullName,
        customer_email: customer.email.toLowerCase(),
        customer_phone: customer.phone,
        shipping_address: customer.address,
        subtotal,
        shipping_fee: shippingFee,
        total,
        status: 'Pending',
        payment_method: opts.paymentMethod || 'pay_on_delivery',
        payment_status: 'pending',
        estimated_delivery: opts.estimatedDelivery || '3-5 business days'
      }])
      .select('id, order_number, tracking_code, total, status, created_at')
      .single();
    if (oErr) throw oErr;

    // 4. Insert order items (snapshot product info)
    const orderItems = items.map(i => ({
      order_id: order.id,
      product_id: i.product_id,
      product_name: i.name,
      product_image: i.image_url,
      size: i.size,
      color: i.color,
      quantity: i.quantity,
      unit_price: i.price,
      subtotal: i.line_total
    }));
    const { error: oiErr } = await supabase.from('order_items').insert(orderItems);
    if (oiErr) throw oiErr;

    // 5. Clear cart
    await Cart.clear(sessionId);

    return { order, items: orderItems };
  },

  // Public tracking — lookup by tracking code only (no email required)
  trackByCode: async (code) => {
    const { data, error } = await supabase
      .from('orders')
      .select(`
        id, order_number, tracking_code, status, total, subtotal,
        shipping_fee, estimated_delivery, created_at, updated_at,
        customer_name, customer_email,
        order_items(product_name, product_image, size, color, quantity, unit_price, subtotal),
        order_status_history(status, note, created_at)
      `)
      .eq('tracking_code', code.toUpperCase())
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;

    // Sort history chronologically
    if (data.order_status_history) {
      data.order_status_history.sort((a, b) =>
        new Date(a.created_at) - new Date(b.created_at));
    }
    return data;
  },

  // Fallback: track by order number + email (kept for edge cases)
  trackByNumberAndEmail: async (orderNumber, email) => {
    const { data, error } = await supabase
      .from('orders')
      .select(`
        id, order_number, tracking_code, status, total, subtotal,
        shipping_fee, estimated_delivery, created_at, updated_at,
        customer_name, customer_email,
        order_items(product_name, product_image, size, color, quantity, unit_price, subtotal),
        order_status_history(status, note, created_at)
      `)
      .eq('order_number', orderNumber)
      .eq('customer_email', email.toLowerCase())
      .maybeSingle();
    if (error) throw error;
    return data;
  }
};

// ============================================
// CONTROLLERS
// ============================================

const productController = {
  getAll: async (req, res) => {
    try {
      const { category, limit, offset, sort } = req.query;
      const products = await Product.findAll({ category, limit, offset, sort });
      res.json({ success: true, products, count: products.length });
    } catch (err) {
      console.error('Get products error:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch products' });
    }
  },

  getById: async (req, res) => {
    try {
      const product = await Product.findById(req.params.id);
      if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
      res.json({ success: true, product });
    } catch (err) {
      console.error('Get product error:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch product' });
    }
  },

  getByCategory: async (req, res) => {
    try {
      const products = await Product.findAll({ category: req.params.category });
      res.json({ success: true, products, count: products.length });
    } catch (err) {
      console.error('Get by category error:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch products' });
    }
  },

  search: async (req, res) => {
    try {
      const q = (req.query.q || '').trim();
      if (!q) return res.json({ success: true, products: [], count: 0 });
      const products = await Product.search(q);
      res.json({ success: true, products, count: products.length });
    } catch (err) {
      console.error('Search error:', err);
      res.status(500).json({ success: false, message: 'Failed to search products' });
    }
  },

  getReviews: async (req, res) => {
    try {
      const reviews = await Product.getReviews(req.params.id);
      res.json({ success: true, reviews });
    } catch (err) {
      console.error('Get reviews error:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch reviews' });
    }
  },

  addReview: async (req, res) => {
    try {
      const { userName, email, rating, comment } = req.body;
      if (!userName || !rating) {
        return res.status(400).json({ success: false, message: 'Name and rating are required' });
      }
      const review = await Product.addReview({
        productId: req.params.id,
        userName, email,
        rating, comment
      });
      res.status(201).json({ success: true, message: 'Review submitted', review });
    } catch (err) {
      console.error('Add review error:', err);
      res.status(500).json({ success: false, message: 'Failed to add review' });
    }
  }
};

const cartController = {
  getCart: async (req, res) => {
    try {
      const items = await Cart.getItems(req.sessionId);
      const subtotal = items.reduce((s, i) => s + i.line_total, 0);
      const shipping = calculateShipping(subtotal);
      res.json({
        success: true,
        cart: {
          items,
          subtotal,
          shipping_fee: shipping,
          total: subtotal + shipping,
          count: items.reduce((s, i) => s + i.quantity, 0)
        },
        isGuest: true
      });
    } catch (err) {
      console.error('Get cart error:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch cart' });
    }
  },

  addToCart: async (req, res) => {
    try {
      const { productId, quantity = 1, size = null, color = null } = req.body;
      if (!productId) return res.status(400).json({ success: false, message: 'productId is required' });
      await Cart.addItem(req.sessionId, productId, quantity, size, color);
      res.json({ success: true, message: 'Added to cart' });
    } catch (err) {
      console.error('Add to cart error:', err);
      res.status(400).json({ success: false, message: err.message || 'Failed to add to cart' });
    }
  },

  updateItem: async (req, res) => {
    try {
      const { itemId, quantity } = req.body;
      if (!itemId || quantity == null) {
        return res.status(400).json({ success: false, message: 'itemId and quantity required' });
      }
      await Cart.updateQuantity(req.sessionId, itemId, Number(quantity));
      res.json({ success: true, message: 'Cart updated' });
    } catch (err) {
      console.error('Update cart error:', err);
      res.status(500).json({ success: false, message: 'Failed to update cart' });
    }
  },

  removeItem: async (req, res) => {
    try {
      await Cart.removeItem(req.sessionId, req.params.itemId);
      res.json({ success: true, message: 'Item removed' });
    } catch (err) {
      console.error('Remove item error:', err);
      res.status(500).json({ success: false, message: 'Failed to remove item' });
    }
  },

  clear: async (req, res) => {
    try {
      await Cart.clear(req.sessionId);
      res.json({ success: true, message: 'Cart cleared' });
    } catch (err) {
      console.error('Clear cart error:', err);
      res.status(500).json({ success: false, message: 'Failed to clear cart' });
    }
  }
};

const orderController = {
  createGuestOrder: async (req, res) => {
    try {
      const { fullName, email, phone, address, shippingFee, paymentMethod, estimatedDelivery } = req.body;

      const result = await Order.create(
        req.sessionId,
        { fullName, email, phone, address },
        { shippingFee, paymentMethod, estimatedDelivery }
      );

      res.status(201).json({
        success: true,
        message: 'Order placed successfully!',
        order: {
          id: result.order.id,
          order_number: result.order.order_number,
          tracking_code: result.order.tracking_code, // ← show this to the customer
          total: result.order.total,
          status: result.order.status,
          created_at: result.order.created_at
        },
        items: result.items,
        isGuest: true
      });
    } catch (err) {
      console.error('Create order error:', err);
      res.status(400).json({ success: false, message: err.message || 'Failed to place order' });
    }
  },

  // Public tracking — by tracking code (primary) OR order_number + email (fallback)
  trackOrder: async (req, res) => {
    try {
      const { code, id, email } = req.query;

      let order = null;
      if (code) {
        order = await Order.trackByCode(code.trim());
      } else if (id && email) {
        order = await Order.trackByNumberAndEmail(id.trim(), email.trim());
      } else {
        return res.status(400).json({
          success: false,
          message: 'Provide a tracking code, or order number + email'
        });
      }

      if (!order) {
        return res.status(404).json({ success: false, message: 'Order not found' });
      }

      res.json({ success: true, order });
    } catch (err) {
      console.error('Track order error:', err);
      res.status(500).json({ success: false, message: 'Failed to track order' });
    }
  }
};

const newsletterController = {
  subscribe: async (req, res) => {
    try {
      const email = (req.body.email || '').trim().toLowerCase();
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return res.status(400).json({ success: false, message: 'Valid email required' });
      }
      const { error } = await supabase
        .from('newsletter_subscribers')
        .upsert([{ email }], { onConflict: 'email' });
      if (error) throw error;
      res.json({ success: true, message: 'Subscribed!' });
    } catch (err) {
      console.error('Newsletter error:', err);
      res.status(500).json({ success: false, message: 'Failed to subscribe' });
    }
  }
};

// ============================================
// ROUTES
// ============================================

// Products
app.get('/api/products', productController.getAll);
app.get('/api/products/search', productController.search);
app.get('/api/products/category/:category', productController.getByCategory);
app.get('/api/products/:id', productController.getById);
app.get('/api/products/:id/reviews', productController.getReviews);
app.post('/api/products/:id/reviews', productController.addReview);

// Cart
app.get('/api/cart', cartController.getCart);
app.post('/api/cart/add', cartController.addToCart);
app.put('/api/cart/update', cartController.updateItem);
app.delete('/api/cart/remove/:itemId', cartController.removeItem);
app.delete('/api/cart/clear', cartController.clear);

// Wishlist — handled entirely client-side (localStorage). No API needed.
// (Kept out on purpose; your frontend already has the toggle UI.)

// Orders
app.post('/api/orders/guest', validations.guestOrder, orderController.createGuestOrder);
app.get('/api/orders/track', orderController.trackOrder);

// Newsletter
app.post('/api/newsletter/subscribe', newsletterController.subscribe);

// ============================================
// HEALTH & ROOT
// ============================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'MAXIFLAIR.NG API', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({
    service: 'MAXIFLAIR.NG API',
    version: '2.0.0',
    status: 'running',
    mode: 'guest-only',
    endpoints: {
      products: 'GET /api/products',
      product: 'GET /api/products/:id',
      search: 'GET /api/products/search?q=',
      reviews: 'GET|POST /api/products/:id/reviews',
      cart: 'GET /api/cart',
      cartAdd: 'POST /api/cart/add',
      cartUpdate: 'PUT /api/cart/update',
      cartRemove: 'DELETE /api/cart/remove/:itemId',
      orderCreate: 'POST /api/orders/guest',
      orderTrack: 'GET /api/orders/track?code=TRK-XXXX',
      newsletter: 'POST /api/newsletter/subscribe'
    }
  });
});

// ============================================
// 404 & ERROR HANDLERS
// ============================================
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'API endpoint not found' });
});

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal Server Error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// ============================================
// START
// ============================================
const startServer = async () => {
  try {
    const { error } = await supabase.from('products').select('id').limit(1);
    if (error) {
      console.error('❌ Supabase connection error:', error.message);
      process.exit(1);
    }
    console.log('✅ Connected to Supabase');

    app.listen(PORT, () => {
      console.log(`🚀 MAXIFLAIR.NG API running on port ${PORT}`);
      console.log(`📦 Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`🌐 Allowed origins: ${allowedOrigins.join(', ')}`);
    });
  } catch (err) {
    console.error('❌ Startup error:', err.message);
    process.exit(1);
  }
};

if (require.main === module) startServer();
module.exports = app;