// ============================================
// MAXIFLAIR.NG - Vercel Serverless API
// ============================================

const express = require('express');
const session = require('express-session');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { body, validationResult } = require('express-validator');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
require('dotenv').config();

const app = express();

// ============================================
// SUPABASE CONFIGURATION
// ============================================

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Constants
const CONSTANTS = {
    ORDER_STATUS: {
        PENDING: 'Pending',
        PROCESSING: 'Processing',
        SHIPPED: 'Shipped',
        DELIVERED: 'Delivered',
        CANCELLED: 'Cancelled',
        REFUNDED: 'Refunded'
    },
    PAYMENT_STATUS: {
        PENDING: 'Pending',
        PAID: 'Paid',
        FAILED: 'Failed',
        REFUNDED: 'Refunded'
    },
    TAX_RATE: 0.075,
    PAGINATION: {
        DEFAULT_LIMIT: 20,
        MAX_LIMIT: 100
    }
};

// ============================================
// MIDDLEWARE
// ============================================

app.use(helmet({
    contentSecurityPolicy: false,
}));
app.use(cors({
    origin: process.env.NODE_ENV === 'production' 
        ? ['https://maxi-flair.vercel.app', 'https://maxiflair.vercel.app', 'http://localhost:3000']
        : '*',
    credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan('dev'));

// Session configuration for Vercel (in-memory, not persistent)
app.use(session({
    secret: process.env.SESSION_SECRET || 'maxiflair-super-secret-key-2025',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        maxAge: 1000 * 60 * 60 * 24,
        sameSite: 'lax'
    }
}));

// Generate guest ID
const getGuestId = (req) => {
    if (!req.session.guestId) {
        req.session.guestId = 'guest_' + crypto.randomBytes(16).toString('hex');
    }
    return req.session.guestId;
};

// ============================================
// VALIDATION
// ============================================

const validate = (req, res, next) => {
    const errors = validationResult(req);
    if (errors.isEmpty()) {
        return next();
    }
    const extractedErrors = errors.array().map(err => ({
        field: err.path,
        message: err.msg
    }));
    return res.status(400).json({
        success: false,
        errors: extractedErrors
    });
};

const validations = {
    guestOrder: [
        body('email')
            .trim()
            .notEmpty().withMessage('Email is required for order confirmation')
            .isEmail().withMessage('Please provide a valid email'),
        body('fullName')
            .trim()
            .notEmpty().withMessage('Full name is required'),
        body('phone')
            .trim()
            .notEmpty().withMessage('Phone number is required'),
        validate
    ]
};

// ============================================
// MODELS
// ============================================

// Guest User Model
const User = {
    createGuest: async (userData) => {
        const { fullName, email, phone } = userData;
        const { data, error } = await supabase
            .from('users')
            .insert([{
                full_name: fullName,
                email: email,
                phone: phone,
                password_hash: null,
                is_guest: true
            }])
            .select('id, full_name, email, phone, is_premium, member_since')
            .single();
        
        if (error) throw error;
        return data;
    },
    findByEmail: async (email) => {
        const { data, error } = await supabase
            .from('users')
            .select('*')
            .eq('email', email)
            .maybeSingle();
        
        if (error) throw error;
        return data;
    },
    addAddress: async (userId, addressData) => {
        const { addressType, addressLine1, addressLine2, city, state, postalCode, country, isDefault } = addressData;
        
        if (isDefault) {
            await supabase
                .from('user_addresses')
                .update({ is_default: false })
                .eq('user_id', userId);
        }
        
        const { data, error } = await supabase
            .from('user_addresses')
            .insert([{
                user_id: userId,
                address_type: addressType,
                address_line1: addressLine1,
                address_line2: addressLine2,
                city: city,
                state: state,
                postal_code: postalCode,
                country: country,
                is_default: isDefault
            }])
            .select('*')
            .single();
        
        if (error) throw error;
        return data;
    }
};

// Product Model
const Product = {
    findAll: async (filters = {}) => {
        const { category, limit = 20, offset = 0, sort = 'newest' } = filters;
        let query = supabase
            .from('products')
            .select(`
                *,
                product_images!left(image_url),
                product_variants!left(size, color, color_code)
            `)
            .eq('is_active', true)
            .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

        if (category && category !== 'All') {
            if (category === 'New Arrivals' || category === 'Best Sellers') {
                query = query.contains('tags', [category]);
            } else {
                query = query.eq('category', category);
            }
        }

        switch(sort) {
            case 'price-low': query = query.order('sale_price', { ascending: true, nullsFirst: false }); break;
            case 'price-high': query = query.order('sale_price', { ascending: false, nullsFirst: false }); break;
            case 'best-selling': query = query.order('review_count', { ascending: false }); break;
            default: query = query.order('created_at', { ascending: false });
        }

        const { data, error } = await query;
        if (error) throw error;
        return data;
    },
    findById: async (id) => {
        const { data, error } = await supabase
            .from('products')
            .select(`
                *,
                product_images!left(image_url, is_primary),
                product_variants!left(size, color, color_code, stock_quantity)
            `)
            .eq('id', id)
            .eq('is_active', true)
            .maybeSingle();
        
        if (error) throw error;
        return data;
    },
    search: async (queryText) => {
        const { data, error } = await supabase
            .from('products')
            .select(`
                *,
                product_images!left(image_url)
            `)
            .eq('is_active', true)
            .or(`name.ilike.%${queryText}%,description.ilike.%${queryText}%,category.ilike.%${queryText}%`)
            .order('created_at', { ascending: false })
            .limit(10);
        
        if (error) throw error;
        return data;
    },
    getReviews: async (productId) => {
        const { data, error } = await supabase
            .from('reviews')
            .select(`
                *,
                users!inner(full_name)
            `)
            .eq('product_id', productId)
            .eq('is_approved', true)
            .order('created_at', { ascending: false });
        
        if (error) throw error;
        return data.map(review => ({
            ...review,
            user_name: review.users.full_name
        }));
    },
    addReview: async (productId, userId, rating, comment, title) => {
        const { data, error } = await supabase
            .from('reviews')
            .insert([{
                product_id: productId,
                user_id: userId,
                rating: rating,
                title: title,
                comment: comment,
                is_approved: false
            }])
            .select('*')
            .single();
        
        if (error) throw error;
        await Product.updateRating(productId);
        return data;
    },
    updateRating: async (productId) => {
        const { data: reviews } = await supabase
            .from('reviews')
            .select('rating')
            .eq('product_id', productId)
            .eq('is_approved', true);

        const avgRating = reviews && reviews.length > 0 
            ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length 
            : 0;
        
        await supabase
            .from('products')
            .update({
                average_rating: avgRating,
                review_count: reviews ? reviews.length : 0
            })
            .eq('id', productId);
    }
};

// Cart Model - Guest Only
const Cart = {
    getOrCreateGuest: async (guestId) => {
        let { data, error } = await supabase
            .from('cart')
            .select('id')
            .eq('session_id', guestId)
            .maybeSingle();
        
        if (error) throw error;
        
        if (!data) {
            const { data: newCart, error: createError } = await supabase
                .from('cart')
                .insert([{ session_id: guestId }])
                .select('id')
                .single();
            
            if (createError) throw createError;
            data = newCart;
        }
        return data.id;
    },
    getItems: async (cartId) => {
        const { data, error } = await supabase
            .from('cart_items')
            .select(`
                *,
                products!inner(name, price, sale_price),
                product_variants!left(size, color, color_code)
            `)
            .eq('cart_id', cartId);
        
        if (error) throw error;
        
        for (let item of data) {
            const { data: image } = await supabase
                .from('product_images')
                .select('image_url')
                .eq('product_id', item.product_id)
                .eq('is_primary', true)
                .limit(1)
                .maybeSingle();
            
            item.image_url = image?.image_url || null;
            item.effective_price = item.products.sale_price || item.products.price;
            item.name = item.products.name;
        }
        
        return data;
    },
    addItem: async (cartId, productId, variantId, quantity) => {
        const { data: product, error: productError } = await supabase
            .from('products')
            .select('id, in_stock')
            .eq('id', productId)
            .maybeSingle();
        
        if (productError) throw productError;
        if (!product) throw new Error('Product not found');
        if (!product.in_stock) throw new Error('Product is out of stock');
        
        let query = supabase
            .from('cart_items')
            .select('id, quantity')
            .eq('cart_id', cartId)
            .eq('product_id', productId);
        
        if (variantId) {
            query = query.eq('variant_id', variantId);
        } else {
            query = query.is('variant_id', null);
        }
        
        const { data: existing, error: existingError } = await query.maybeSingle();
        
        if (existingError) throw existingError;
        
        if (existing) {
            const { error: updateError } = await supabase
                .from('cart_items')
                .update({ 
                    quantity: existing.quantity + quantity,
                    updated_at: new Date().toISOString()
                })
                .eq('id', existing.id);
            
            if (updateError) throw updateError;
        } else {
            const { error: insertError } = await supabase
                .from('cart_items')
                .insert([{
                    cart_id: cartId,
                    product_id: productId,
                    variant_id: variantId,
                    quantity: quantity
                }]);
            
            if (insertError) throw insertError;
        }
        
        return true;
    },
    updateQuantity: async (cartId, productId, quantity) => {
        if (quantity === 0) {
            const { error } = await supabase
                .from('cart_items')
                .delete()
                .eq('cart_id', cartId)
                .eq('product_id', productId);
            
            if (error) throw error;
        } else {
            const { error } = await supabase
                .from('cart_items')
                .update({ 
                    quantity: quantity,
                    updated_at: new Date().toISOString()
                })
                .eq('cart_id', cartId)
                .eq('product_id', productId);
            
            if (error) throw error;
        }
        return true;
    },
    removeItem: async (cartId, productId) => {
        const { error } = await supabase
            .from('cart_items')
            .delete()
            .eq('cart_id', cartId)
            .eq('product_id', productId);
        
        if (error) throw error;
        return true;
    },
    clear: async (cartId) => {
        const { error } = await supabase
            .from('cart_items')
            .delete()
            .eq('cart_id', cartId);
        
        if (error) throw error;
        return true;
    }
};

// Wishlist Model - Guest Only
const Wishlist = {
    getGuestItems: async (sessionId) => {
        const { data, error } = await supabase
            .from('wishlist')
            .select(`
                *,
                products!inner(name, price, sale_price, in_stock)
            `)
            .eq('session_id', sessionId)
            .order('created_at', { ascending: false });
        
        if (error) throw error;
        
        for (let item of data) {
            const { data: image } = await supabase
                .from('product_images')
                .select('image_url')
                .eq('product_id', item.product_id)
                .eq('is_primary', true)
                .limit(1)
                .maybeSingle();
            
            item.image_url = image?.image_url || null;
            item.effective_price = item.products.sale_price || item.products.price;
            item.name = item.products.name;
        }
        
        return data;
    },
    toggleGuest: async (sessionId, productId) => {
        const { data: product, error: productError } = await supabase
            .from('products')
            .select('id')
            .eq('id', productId)
            .eq('is_active', true)
            .maybeSingle();
        
        if (productError) throw productError;
        if (!product) throw new Error('Product not found');
        
        const { data: existing, error: existingError } = await supabase
            .from('wishlist')
            .select('id')
            .eq('session_id', sessionId)
            .eq('product_id', productId)
            .maybeSingle();
        
        if (existingError) throw existingError;
        
        if (existing) {
            await supabase
                .from('wishlist')
                .delete()
                .eq('id', existing.id);
            
            return { action: 'removed', message: 'Removed from wishlist' };
        } else {
            await supabase
                .from('wishlist')
                .insert([{
                    session_id: sessionId,
                    product_id: productId
                }]);
            
            return { action: 'added', message: 'Added to wishlist' };
        }
    },
    removeGuestItem: async (sessionId, productId) => {
        const { error } = await supabase
            .from('wishlist')
            .delete()
            .eq('session_id', sessionId)
            .eq('product_id', productId);
        
        if (error) throw error;
        return true;
    }
};

// Order Model - Guest Only
const Order = {
    createGuestOrder: async (guestData, orderData) => {
        const { fullName, email, phone, address } = guestData;
        const { shippingCost = 0, discount = 0 } = orderData;
        
        let user = await User.findByEmail(email);
        if (!user) {
            user = await User.createGuest({ fullName, email, phone });
        }
        
        let addressId = null;
        if (address) {
            const addrResult = await User.addAddress(user.id, {
                addressType: 'Home',
                addressLine1: address.line1,
                addressLine2: address.line2 || '',
                city: address.city,
                state: address.state,
                postalCode: address.postalCode || '',
                country: 'Nigeria',
                isDefault: true
            });
            addressId = addrResult.id;
        }
        
        const guestId = orderData.guestId;
        const { data: guestCart, error: guestError } = await supabase
            .from('cart')
            .select('id')
            .eq('session_id', guestId)
            .maybeSingle();
        
        if (guestError) throw guestError;
        if (!guestCart) throw new Error('No items in cart');
        
        const guestCartId = guestCart.id;
        const items = await Cart.getItems(guestCartId);
        
        if (items.length === 0) throw new Error('Cart is empty');
        
        const subtotal = items.reduce((sum, item) => sum + (item.effective_price * item.quantity), 0);
        const tax = subtotal * CONSTANTS.TAX_RATE;
        const total = subtotal + shippingCost + tax - discount;
        const orderNumber = `MXF-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${Math.floor(1000 + Math.random() * 9000)}`;
        
        const { data: order, error: orderError } = await supabase
            .from('orders')
            .insert([{
                order_number: orderNumber,
                user_id: user.id,
                subtotal: subtotal,
                shipping_cost: shippingCost,
                tax: tax,
                discount: discount,
                total: total,
                shipping_address_id: addressId,
                status: 'Pending'
            }])
            .select('id, order_number, created_at')
            .single();
        
        if (orderError) throw orderError;
        
        for (const item of items) {
            const { error: itemError } = await supabase
                .from('order_items')
                .insert([{
                    order_id: order.id,
                    product_id: item.product_id,
                    variant_id: item.variant_id,
                    product_name: item.name,
                    product_price: item.effective_price,
                    quantity: item.quantity,
                    size: item.size,
                    color: item.color,
                    total_price: item.effective_price * item.quantity
                }]);
            
            if (itemError) throw itemError;
            
            const { data: product } = await supabase
                .from('products')
                .select('stock_quantity')
                .eq('id', item.product_id)
                .single();
            
            const newStock = product.stock_quantity - item.quantity;
            await supabase
                .from('products')
                .update({
                    stock_quantity: newStock,
                    in_stock: newStock > 0
                })
                .eq('id', item.product_id);
        }
        
        await Cart.clear(guestCartId);
        
        return { order, user };
    },
    getOrderById: async (orderId, email) => {
        const user = await User.findByEmail(email);
        if (!user) return null;
        
        const { data, error } = await supabase
            .from('orders')
            .select(`
                *,
                users!inner(full_name, email, phone),
                user_addresses!left(address_line1, address_line2, city, state, postal_code),
                order_items!left(
                    product_name,
                    product_price,
                    quantity,
                    size,
                    color,
                    total_price
                )
            `)
            .eq('id', orderId)
            .eq('user_id', user.id)
            .maybeSingle();
        
        if (error) throw error;
        return data;
    },
    getOrdersByEmail: async (email) => {
        const user = await User.findByEmail(email);
        if (!user) return [];
        
        const { data, error } = await supabase
            .from('orders')
            .select(`
                *,
                order_items(count)
            `)
            .eq('user_id', user.id)
            .order('created_at', { ascending: false });
        
        if (error) throw error;
        return data;
    }
};

// ============================================
// CONTROLLERS
// ============================================

const productController = {
    getAllProducts: async (req, res) => {
        try {
            const { category, limit, offset, sort } = req.query;
            const products = await Product.findAll({ category, limit, offset, sort });
            res.json({
                success: true,
                products,
                count: products.length
            });
        } catch (error) {
            console.error('Get products error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch products'
            });
        }
    },
    getProductById: async (req, res) => {
        try {
            const { id } = req.params;
            const product = await Product.findById(id);
            if (!product) {
                return res.status(404).json({
                    success: false,
                    message: 'Product not found'
                });
            }
            res.json({
                success: true,
                product
            });
        } catch (error) {
            console.error('Get product error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch product'
            });
        }
    },
    searchProducts: async (req, res) => {
        try {
            const { q } = req.query;
            if (!q) {
                return res.json({
                    success: true,
                    products: [],
                    count: 0
                });
            }
            const products = await Product.search(q);
            res.json({
                success: true,
                products,
                count: products.length
            });
        } catch (error) {
            console.error('Search products error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to search products'
            });
        }
    },
    getProductReviews: async (req, res) => {
        try {
            const { id } = req.params;
            const reviews = await Product.getReviews(id);
            res.json({
                success: true,
                reviews
            });
        } catch (error) {
            console.error('Get reviews error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch reviews'
            });
        }
    },
    addReview: async (req, res) => {
        try {
            const { id } = req.params;
            const { email, rating, title, comment } = req.body;
            
            if (!email) {
                return res.status(400).json({
                    success: false,
                    message: 'Email is required to leave a review'
                });
            }
            
            let user = await User.findByEmail(email);
            if (!user) {
                const { data, error } = await supabase
                    .from('users')
                    .insert([{
                        full_name: email.split('@')[0],
                        email: email,
                        phone: '0000000000',
                        password_hash: null,
                        is_guest: true
                    }])
                    .select('id')
                    .single();
                
                if (error) throw error;
                user = data;
            }
            
            const review = await Product.addReview(id, user.id, rating, comment, title);
            res.status(201).json({
                success: true,
                message: 'Review added successfully',
                review,
                isVerified: false
            });
        } catch (error) {
            console.error('Add review error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to add review'
            });
        }
    }
};

const cartController = {
    getCart: async (req, res) => {
        try {
            const guestId = getGuestId(req);
            const cartId = await Cart.getOrCreateGuest(guestId);
            const items = await Cart.getItems(cartId);
            const subtotal = items.reduce((sum, item) => sum + (item.effective_price * item.quantity), 0);
            req.session.cart = items;
            res.json({
                success: true,
                cart: {
                    id: cartId,
                    items: items,
                    subtotal: subtotal,
                    total: subtotal,
                    count: items.reduce((sum, item) => sum + item.quantity, 0)
                },
                isGuest: true
            });
        } catch (error) {
            console.error('Get cart error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch cart'
            });
        }
    },
    addToCart: async (req, res) => {
        try {
            const { productId, variantId, quantity = 1 } = req.body;
            const guestId = getGuestId(req);
            const cartId = await Cart.getOrCreateGuest(guestId);
            await Cart.addItem(cartId, productId, variantId, quantity);
            res.json({
                success: true,
                message: 'Added to cart successfully'
            });
        } catch (error) {
            console.error('Add to cart error:', error);
            res.status(500).json({
                success: false,
                message: error.message || 'Failed to add to cart'
            });
        }
    },
    updateCartItem: async (req, res) => {
        try {
            const { productId, quantity } = req.body;
            if (quantity < 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid quantity'
                });
            }
            const guestId = getGuestId(req);
            const cartId = await Cart.getOrCreateGuest(guestId);
            await Cart.updateQuantity(cartId, productId, quantity);
            res.json({
                success: true,
                message: 'Cart updated successfully'
            });
        } catch (error) {
            console.error('Update cart error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to update cart'
            });
        }
    },
    removeFromCart: async (req, res) => {
        try {
            const { productId } = req.params;
            const guestId = getGuestId(req);
            const cartId = await Cart.getOrCreateGuest(guestId);
            await Cart.removeItem(cartId, productId);
            res.json({
                success: true,
                message: 'Removed from cart successfully'
            });
        } catch (error) {
            console.error('Remove from cart error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to remove from cart'
            });
        }
    },
    clearCart: async (req, res) => {
        try {
            const guestId = getGuestId(req);
            const cartId = await Cart.getOrCreateGuest(guestId);
            await Cart.clear(cartId);
            res.json({
                success: true,
                message: 'Cart cleared successfully'
            });
        } catch (error) {
            console.error('Clear cart error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to clear cart'
            });
        }
    }
};

const wishlistController = {
    getWishlist: async (req, res) => {
        try {
            const guestId = getGuestId(req);
            const items = await Wishlist.getGuestItems(guestId);
            res.json({
                success: true,
                wishlist: items,
                count: items.length,
                isGuest: true
            });
        } catch (error) {
            console.error('Get wishlist error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch wishlist'
            });
        }
    },
    toggleWishlist: async (req, res) => {
        try {
            const { productId } = req.body;
            const guestId = getGuestId(req);
            const result = await Wishlist.toggleGuest(guestId, productId);
            res.json({
                success: true,
                message: result.message,
                action: result.action,
                isGuest: true
            });
        } catch (error) {
            console.error('Toggle wishlist error:', error);
            res.status(500).json({
                success: false,
                message: error.message || 'Failed to update wishlist'
            });
        }
    },
    removeFromWishlist: async (req, res) => {
        try {
            const { productId } = req.params;
            const guestId = getGuestId(req);
            await Wishlist.removeGuestItem(guestId, productId);
            res.json({
                success: true,
                message: 'Removed from wishlist successfully'
            });
        } catch (error) {
            console.error('Remove from wishlist error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to remove from wishlist'
            });
        }
    }
};

const orderController = {
    createGuestOrder: async (req, res) => {
        try {
            const { fullName, email, phone, address, shippingCost, discount } = req.body;
            
            if (!fullName || !email || !phone) {
                return res.status(400).json({
                    success: false,
                    message: 'Please provide full name, email, and phone number'
                });
            }
            
            const guestId = getGuestId(req);
            const result = await Order.createGuestOrder(
                { fullName, email, phone, address },
                { guestId, shippingCost: shippingCost || 0, discount: discount || 0 }
            );
            
            res.json({
                success: true,
                message: 'Order placed successfully! Check your email for confirmation.',
                order: result.order,
                user: result.user,
                isGuest: true
            });
        } catch (error) {
            console.error('Create guest order error:', error);
            res.status(500).json({
                success: false,
                message: error.message || 'Failed to place order'
            });
        }
    },
    getOrderById: async (req, res) => {
        try {
            const { id } = req.params;
            const { email } = req.query;
            
            if (!email) {
                return res.status(400).json({
                    success: false,
                    message: 'Email is required to view orders'
                });
            }
            
            const order = await Order.getOrderById(id, email);
            if (!order) {
                return res.status(404).json({
                    success: false,
                    message: 'Order not found'
                });
            }
            
            res.json({
                success: true,
                order
            });
        } catch (error) {
            console.error('Get order error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch order'
            });
        }
    },
    getOrdersByEmail: async (req, res) => {
        try {
            const { email } = req.query;
            
            if (!email) {
                return res.status(400).json({
                    success: false,
                    message: 'Email is required to view orders'
                });
            }
            
            const orders = await Order.getOrdersByEmail(email);
            res.json({
                success: true,
                orders,
                count: orders.length
            });
        } catch (error) {
            console.error('Get orders error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch orders'
            });
        }
    }
};

// ============================================
// ADMIN ROUTES
// ============================================

app.get('/api/admin/about-content', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('about_content')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        
        if (error) throw error;
        
        if (data) {
            res.json({
                success: true,
                content: data.content
            });
        } else {
            const defaultContent = {
                hero: {
                    title: 'Our Story',
                    subtitle: 'Elegance in every thread',
                    image: 'https://images.unsplash.com/photo-1550614000-4b95d4662231?auto=format&fit=crop&q=80&w=2000'
                },
                story: {
                    tagline: 'At Maxiflair.ng, we believe every woman deserves to feel elegant and confident.',
                    content: [
                        'Founded in the heart of Nigeria, MAXIFLAIR.NG was born out of a simple desire: to provide modern women with high-quality, beautifully tailored maxi skirts and dresses that don\'t compromise on comfort or style.',
                        'Whether you\'re a student looking for that perfect weekend outfit, a working professional needing versatile office-to-evening wear, or a fashion lover attending a special event, our collections are designed with you in mind.'
                    ]
                },
                quality: {
                    title: 'Our Commitment to Quality',
                    content: [
                        'We meticulously source our fabrics—from breathable cottons and linens perfect for the tropical climate, to luxurious silks and velvets for those unforgettable nights.',
                        'Operating from Benin and Asaba, we proudly deliver nationwide. Our seamless online shopping experience, secure payment gateways, and dedicated customer service team ensure you feel valued.'
                    ]
                },
                delivery: {
                    title: 'Delivery Information',
                    subtitle: 'Fast, secure & nationwide delivery — because your style shouldn\'t wait.',
                    processing: {
                        label: 'Orders are processed within 24–48 hours.',
                        weekend: 'Orders placed on weekends are processed on Monday.'
                    },
                    times: [
                        { location: 'Benin', time: '1 Day' },
                        { location: 'Lagos', time: '2–3 Days' },
                        { location: 'Abuja', time: '2–4 Days' },
                        { location: 'Other States', time: '3–5 Days' }
                    ],
                    partners: ['GIG Logistics', 'ABC Cargo', 'Peace Mass', 'Local Dispatch']
                },
                returns: {
                    title: 'Returns & Exchanges',
                    subtitle: 'Shop with confidence — we make returns and exchanges simple.',
                    policy: {
                        title: 'Return within 7 days of receiving your order.',
                        items: ['Unused', 'Unwashed', 'Original Tag', 'Original Packaging']
                    },
                    cannotReturn: [
                        'Sale Items — final sale items cannot be returned.',
                        'Damaged by Customer — wear and tear, stains, or alterations.',
                        'Worn Clothing — items that have been worn or washed.'
                    ],
                    exchange: {
                        title: 'Wrong size? Wrong colour? We exchange within 7 days.',
                        points: [
                            'Exchange for a different size or colour.',
                            'Subject to stock availability.',
                            'Free exchange shipping on orders over ₦50,000.'
                        ]
                    }
                },
                size: {
                    title: 'Size Guide',
                    subtitle: 'Find your perfect fit for maxi dresses, skirts, and tops.',
                    dresses: {
                        headers: ['Size', 'Bust (cm)', 'Waist (cm)', 'Hip (cm)', 'Length (cm)'],
                        rows: [
                            ['XS', '82', '64', '90', '145'],
                            ['S', '87', '69', '95', '146'],
                            ['M', '92', '74', '100', '147'],
                            ['L', '97', '79', '105', '148'],
                            ['XL', '102', '84', '110', '149'],
                            ['XXL', '107', '89', '115', '150']
                        ]
                    },
                    skirts: {
                        headers: ['Size', 'Waist (cm)', 'Hip (cm)', 'Length (cm)'],
                        rows: [
                            ['XS', '64', '90', '105'],
                            ['S', '69', '95', '106'],
                            ['M', '74', '100', '107'],
                            ['L', '79', '105', '108'],
                            ['XL', '84', '110', '109'],
                            ['XXL', '89', '115', '110']
                        ]
                    },
                    tops: {
                        headers: ['Size', 'Bust (cm)', 'Waist (cm)', 'Shoulder (cm)'],
                        rows: [
                            ['XS', '82', '64', '36'],
                            ['S', '87', '69', '37'],
                            ['M', '92', '74', '38'],
                            ['L', '97', '79', '39'],
                            ['XL', '102', '84', '40'],
                            ['XXL', '107', '89', '41']
                        ]
                    }
                },
                faq: {
                    title: 'Frequently Asked Questions',
                    subtitle: 'Find quick answers to the most common questions.',
                    items: [
                        { question: 'How do I place an order?', answer: 'Simply browse our collection, select your preferred items, choose your size and colour, then proceed to checkout.' },
                        { question: 'What payment methods do you accept?', answer: 'We accept debit/credit cards (Visa, Mastercard), bank transfers, and secure mobile payments via Paystack.' },
                        { question: 'How long does delivery take?', answer: 'Delivery times vary by location: Benin (1 day), Lagos (2–3 days), Abuja (2–4 days), and other states (3–5 days).' },
                        { question: 'Can I return an item?', answer: 'Yes, we accept returns within 7 days of receipt. Items must be unused, unwashed, with original tags.' }
                    ]
                },
                support: {
                    title: 'Still Need Help?',
                    subtitle: 'Our customer care team is ready to assist you.',
                    hours: 'Monday – Saturday | 8:00 AM – 6:00 PM'
                }
            };
            
            res.json({
                success: true,
                content: defaultContent
            });
        }
    } catch (error) {
        console.error('Get about content error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch about content'
        });
    }
});

app.put('/api/admin/about-content', async (req, res) => {
    try {
        const { content } = req.body;
        
        if (!content) {
            return res.status(400).json({
                success: false,
                message: 'Content is required'
            });
        }
        
        const { data: existing, error: checkError } = await supabase
            .from('about_content')
            .select('id')
            .limit(1)
            .maybeSingle();
        
        if (checkError) throw checkError;
        
        let result;
        if (existing) {
            result = await supabase
                .from('about_content')
                .update({ 
                    content: content,
                    updated_at: new Date().toISOString()
                })
                .eq('id', existing.id)
                .select('*')
                .single();
        } else {
            result = await supabase
                .from('about_content')
                .insert([{ 
                    content: content,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                }])
                .select('*')
                .single();
        }
        
        if (result.error) throw result.error;
        
        res.json({
            success: true,
            message: 'About content updated successfully',
            content: result.data
        });
    } catch (error) {
        console.error('Update about content error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update about content'
        });
    }
});

// ============================================
// ROUTES
// ============================================

app.get('/api/products', productController.getAllProducts);
app.get('/api/products/search', productController.searchProducts);
app.get('/api/products/:id', productController.getProductById);
app.get('/api/products/:id/reviews', productController.getProductReviews);
app.post('/api/products/:id/reviews', productController.addReview);

app.get('/api/cart', cartController.getCart);
app.post('/api/cart/add', cartController.addToCart);
app.put('/api/cart/update', cartController.updateCartItem);
app.delete('/api/cart/remove/:productId', cartController.removeFromCart);
app.delete('/api/cart/clear', cartController.clearCart);

app.get('/api/wishlist', wishlistController.getWishlist);
app.post('/api/wishlist/toggle', wishlistController.toggleWishlist);
app.delete('/api/wishlist/remove/:productId', wishlistController.removeFromWishlist);

app.post('/api/orders/guest', validations.guestOrder, orderController.createGuestOrder);
app.get('/api/orders/track', orderController.getOrderById);
app.get('/api/orders/email', orderController.getOrdersByEmail);

// ============================================
// ERROR HANDLER
// ============================================

const errorHandler = (err, req, res, next) => {
    console.error('Error:', err);
    const status = err.status || 500;
    const message = err.message || 'Internal Server Error';
    res.status(status).json({
        success: false,
        message: message,
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
};

app.use(errorHandler);

// ============================================
// EXPORT FOR VERCEL
// ============================================

module.exports = app;